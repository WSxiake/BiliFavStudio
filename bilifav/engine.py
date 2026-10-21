# -*- coding: utf-8 -*-
"""
复制引擎。

两阶段设计，这是能做断点续传的关键：

  阶段一 · 建索引
      把源收藏夹分页读完，把条目清单**本地化**到状态文件里。
      只读操作，20 条一页，几百条也就几十个请求。
      好处：之后复制阶段完全不依赖线上列表的顺序，即使对方又收藏了新视频、
      或者删了旧视频，我们的清单都是稳定的。中途断了就从上次的页码继续。

  阶段二 · 复制
      遍历本地清单，逐条（或分批）添加到目标收藏夹。每处理一条就落盘一次，
      所以随时中断、随时重启都能接着跑。

风控策略：
  * 每次请求之间强制间隔（默认 1.5s + 随机抖动）；
  * 单条失败自动退避重试；
  * 连续失败过多自动熔断停止；
  * 命中风控直接停，不硬刚。
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

from .api import (
    BiliClient,
    BiliError,
    Cancelled,
    NotLoggedInError,
    RiskControlError,
)
from .state import CopyState, normalize_media
from .util import DUP, FAIL, FATAL, INVALID, OK, classify_fav_error


@dataclass
class CopyOptions:
    """一次复制任务的参数。"""

    index_page_size: int = 20      # 建索引时每页拉取条数（接口上限 20）
    order: str = "mtime"           # 源收藏夹排序：mtime / view / pubtime
    content_type: int = 2          # 0 全部 / 2 仅视频 / 12 仅音频 / 21 合集
    batch_size: int = 1            # 每次提交条数；1 = 最稳，>1 走批量接口
    delay: float = 1.5             # 请求最小间隔（秒）
    jitter: float = 0.6            # 间隔随机抖动上限（秒）
    skip_invalid: bool = True      # 本地判定已失效的直接跳过，省请求
    prescan_target: bool = False   # 复制前先扫目标收藏夹，避免重复添加
    max_consecutive_failures: int = 12   # 连续失败达到此数则熔断
    save_every: int = 1            # 每处理多少条落盘一次


class EngineStopped(Exception):
    """因熔断而主动停止。"""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def state_filename(source_media_id: int, target_media_id: int) -> str:
    return f"src{int(source_media_id)}_to_dst{int(target_media_id)}.json"


class CopyEngine:
    """把源收藏夹的条目搬到目标收藏夹。"""

    def __init__(
        self,
        client: BiliClient,
        state: CopyState,
        options: CopyOptions,
        emit: Callable[[Dict[str, Any]], None],
    ):
        self.client = client
        self.state = state
        self.opts = options
        self.emit = emit

        self.stop_flag = threading.Event()
        self._paused = threading.Event()
        self._batch_unsupported = False
        self._consecutive_failures = 0
        self._processed_since_save = 0
        self._started_at = 0.0
        self._counter = {"done": 0, "dup": 0, "invalid": 0, "failed": 0}

        client.set_cancel(self.stop_flag)
        client.set_delay(options.delay, options.jitter)

    # ---------------- 线程控制 ----------------
    def stop(self) -> None:
        self.stop_flag.set()
        self._paused.clear()

    def pause(self) -> None:
        self._paused.set()
        self._event("state", text="已暂停")

    def resume(self) -> None:
        self._paused.clear()
        self._event("state", text="继续中")

    @property
    def is_paused(self) -> bool:
        return self._paused.is_set()

    def _gate(self) -> None:
        """暂停 / 停止检查点。"""
        while self._paused.is_set():
            if self.stop_flag.is_set():
                raise Cancelled()
            time.sleep(0.1)
        if self.stop_flag.is_set():
            raise Cancelled()

    # ---------------- 事件 ----------------
    def _event(self, kind: str, **payload: Any) -> None:
        payload["type"] = kind
        try:
            self.emit(payload)
        except Exception:
            pass

    def _log(self, text: str, level: str = "info") -> None:
        self._event("log", level=level, text=text)

    def _stats(self) -> Dict[str, int]:
        summary = self.state.summary()
        summary.update(self._counter)
        summary["elapsed"] = int(time.time() - self._started_at) if self._started_at else 0
        return summary

    def _push_progress(self) -> None:
        self._event("progress", **self._stats())

    # ==================================================================
    # 阶段一：建索引
    # ==================================================================
    def build_index(self) -> None:
        idx = self.state.data["index"]
        total_known = int(self.state.data["source"].get("media_count") or 0)

        if idx.get("complete"):
            self._log(f"本地清单已就绪，共 {len(self.state.items)} 条，跳过扫描")
            self._event(
                "index_progress",
                fetched=len(self.state.items),
                total=len(self.state.items),
                finished=True,
            )
            return

        media_id = int(self.state.data["source"]["media_id"])
        seen: Set[str] = {item["key"] for item in self.state.items}
        page = max(1, int(idx.get("next_page") or 1))
        self._log(
            f"开始扫描源收藏夹（收藏夹 ID {media_id}），"
            f"从第 {page} 页继续" if page > 1 else f"开始扫描源收藏夹（收藏夹 ID {media_id}）"
        )

        guard = 0
        while True:
            self._gate()
            guard += 1
            if guard > 20000:
                raise EngineStopped("扫描页数异常，已中止（可能是收藏夹 ID 有误）")

            data = self.client.fav_resource_list(
                media_id,
                pn=page,
                ps=self.opts.index_page_size,
                order=self.opts.order,
                content_type=self.opts.content_type,
            )
            medias = data.get("medias") or []
            items = [normalize_media(m) for m in medias if isinstance(m, dict)]
            added = self.state.add_index_items(items, seen)

            info = data.get("info") or {}
            if info.get("media_count") is not None:
                total_known = int(info["media_count"])

            idx["next_page"] = page + 1
            idx["pages_fetched"] = int(idx.get("pages_fetched") or 0) + 1
            has_more = bool(data.get("has_more"))

            # 统一按 order=mtime 时列表可能动态变化，这里一旦某页全空就认为到底了
            if not medias:
                has_more = False

            self.state.save()
            self._event(
                "index_progress",
                fetched=len(self.state.items),
                total=total_known or len(self.state.items),
                page=page,
                finished=not has_more,
            )
            self._log(
                f"第 {page} 页：新增 {added} 条，累计 {len(self.state.items)}"
                + (f" / 约 {total_known}" if total_known else "")
            )

            if not has_more:
                break
            page += 1

        idx["complete"] = True
        self.state.save()
        self._log(f"扫描完成，本地清单共 {len(self.state.items)} 条", "ok")
        self._event(
            "index_progress",
            fetched=len(self.state.items),
            total=len(self.state.items),
            finished=True,
        )

    # ==================================================================
    # 可选的：预扫目标收藏夹
    # ==================================================================
    def prescan_target(self) -> None:
        target_id = int(self.state.data["target"]["media_id"])
        self._log("预扫目标收藏夹，标记已存在的条目…")
        seen: Set[str] = set()

        # 优先用轻量接口一次拿完所有条目的身份 —— 比逐页拉详情快一个数量级
        # （几百条的收藏夹：几十秒 → 一两秒）。这里只关心"有没有"、不关心顺序，
        # 正好是它最擅长的场景。
        keys: List[str] = []
        try:
            self._gate()
            with self.client.faster(0.5):
                keys = self.client.fav_resource_keys(target_id)
        except (Cancelled, RiskControlError, NotLoggedInError):
            raise
        except BiliError as exc:
            self._log(f"轻量接口没读成（{exc}），改用逐页读取", "warn")
            keys = []

        if keys:
            seen.update(keys)
            self._log(f"一次读到目标收藏夹的 {len(keys)} 条")
        else:
            page = 1
            while True:
                self._gate()
                data = self.client.fav_resource_list(target_id, pn=page, ps=20, order="mtime")
                medias = data.get("medias") or []
                for raw in medias:
                    if not isinstance(raw, dict):
                        continue
                    item = normalize_media(raw)
                    seen.add(item["key"])
                if not medias or not data.get("has_more"):
                    break
                page += 1
                if page > 20000:
                    break

        hit = 0
        for item in self.state.items:
            if item["key"] in seen:
                self.state.mark("duplicate", item["key"])
                hit += 1
        self.state.save()
        self._log(f"预扫完成：源清单里有 {hit} 条已在目标收藏夹中，将自动跳过", "ok")

    # ==================================================================
    # 阶段二：复制
    # ==================================================================
    def run(self) -> str:
        """执行复制。返回结束原因：finished / cancelled / stopped。"""
        self._started_at = time.time()
        self._counter = {"done": 0, "dup": 0, "invalid": 0, "failed": 0}

        try:
            self._event("state", text="建索引")
            self.build_index()

            if self.opts.prescan_target:
                self._event("state", text="预扫目标")
                self.prescan_target()

            self._event("state", text="复制中")
            reason = self._copy_all()
        except Cancelled:
            self.state.save()
            self._log("已停止，进度已保存，下次可以接着跑", "warn")
            return "cancelled"
        except RiskControlError as exc:
            self.state.save()
            self._log(
                f"触发 B 站风控：{exc.message}。已保存进度并停止。"
                f"建议等 30 分钟以上再继续，期间不要刷新收藏夹页面。",
                "error",
            )
            return "risk"
        except NotLoggedInError as exc:
            self.state.save()
            self._log(f"登录态失效：{exc.message}。请重新登录后继续。", "error")
            return "auth"
        except EngineStopped as exc:
            self.state.save()
            self._log(f"已熔断停止：{exc.reason}", "error")
            return "stopped"
        except BiliError as exc:
            self.state.save()
            self._log(f"接口报错，已保存进度：{exc}", "error")
            return "error"
        except Exception as exc:  # noqa: BLE001 - 兜底，保证进度一定落盘
            self.state.save()
            self._log(f"意外错误：{type(exc).__name__}: {exc}", "error")
            return "error"

        self.state.save()
        return reason

    def _copy_all(self) -> str:
        items = self.state.items
        total = len(items)
        marks = self.state.sets()
        finished = marks["done"] | marks["duplicate"] | marks["invalid"]

        pending: List[Tuple[int, Dict[str, Any]]] = [
            (i, it) for i, it in enumerate(items) if it["key"] not in finished
        ]
        # B 站收藏接口是"新加的排最前面"，所以照清单顺序加，最后会是倒的。
        # 反过来加，每加一条往前顶一次，收工正好是原顺序。
        # （cursor 只是显示进度用的，续传靠 marks，倒着走不影响断点续传。）
        pending.reverse()
        self._log(
            f"待处理 {len(pending)} 条 / 清单共 {total} 条"
            + (f"（已有 {len(finished)} 条完成，自动跳过）" if finished else "")
        )
        self._push_progress()

        batch: List[Tuple[int, Dict[str, Any]]] = []
        batch_size = max(1, int(self.opts.batch_size))

        for index, item in pending:
            self._gate()
            self.state.progress["cursor"] = index

            if self.opts.skip_invalid and item.get("invalid"):
                self.state.mark("invalid", item["key"])
                self._counter["invalid"] += 1
                self._after_item()
                continue

            batch.append((index, item))
            if len(batch) >= batch_size:
                self._flush(batch)
                batch = []

        if batch:
            self._flush(batch)

        self.state.progress["cursor"] = total
        self.state.save()
        self._push_progress()

        summary = self.state.summary()
        self._log(
            f"复制结束 —— 新增收藏 {self._counter['done']}，"
            f"已存在 {self._counter['dup']}，失效跳过 {self._counter['invalid']}，"
            f"失败 {self._counter['failed']}；"
            f"清单总计 {summary['total']} 条，剩余未处理 {summary['remaining']} 条",
            "ok",
        )
        return "finished"

    def _after_item(self) -> None:
        self._processed_since_save += 1
        if self._processed_since_save >= max(1, int(self.opts.save_every)):
            self._processed_since_save = 0
            self.state.save()
        self._push_progress()

    # ---------------- 批量提交 ----------------
    def _flush(self, batch: List[Tuple[int, Dict[str, Any]]]) -> None:
        if len(batch) > 1 and not self._batch_unsupported:
            if self._try_batch(batch):
                return
        for index, item in batch:
            self._gate()
            self._add_one(index, item)

    def _try_batch(self, batch: List[Tuple[int, Dict[str, Any]]]) -> bool:
        """尝试走批量接口。整体成功返回 True，否则回退到逐条。"""
        target_id = int(self.state.data["target"]["media_id"])
        resources = [(it["avid"], int(it.get("type") or 2)) for _, it in batch]
        try:
            self.client.fav_batch_deal(resources, add_media_ids=[target_id])
        except (RiskControlError, NotLoggedInError, Cancelled):
            raise
        except BiliError as exc:
            # 批量接口在部分账号 / 部分内容类型下不可用，退回逐条即可
            self._batch_unsupported = True
            self._log(
                f"批量接口不可用（{exc}），后续改为逐条提交（更稳，但会慢一些）",
                "warn",
            )
            return False

        for index, item in batch:
            self.state.progress["cursor"] = index
            self.state.mark("done", item["key"])
            self._counter["done"] += 1
        self._consecutive_failures = 0
        self.state.save()
        self._push_progress()
        return True

    # ---------------- 单条提交 ----------------
    def _add_one(self, index: int, item: Dict[str, Any]) -> None:
        target_id = int(self.state.data["target"]["media_id"])
        try:
            self.client.fav_deal(
                item["avid"],
                add_media_ids=[target_id],
                content_type=int(item.get("type") or 2),
            )
        except Cancelled:
            raise
        except RiskControlError:
            raise
        except NotLoggedInError:
            raise
        except BiliError as exc:
            kind, message = classify_fav_error(exc)
            if kind == FATAL:
                self.state.mark_failed(
                    item["key"], exc.code, message, item.get("title", "")
                )
                self._counter["failed"] += 1
                self.state.save()
                raise EngineStopped(message)
            if kind == DUP:
                self.state.mark("duplicate", item["key"])
                self._counter["dup"] += 1
                self._consecutive_failures = 0
            elif kind == INVALID:
                self.state.mark("invalid", item["key"])
                self._counter["invalid"] += 1
                self._consecutive_failures = 0
                self._log(f"跳过不可用稿件：{item.get('title') or item['key']}", "warn")
            else:
                self.state.mark_failed(
                    item["key"], exc.code, message, item.get("title", "")
                )
                self._counter["failed"] += 1
                self._consecutive_failures += 1
                self._log(
                    f"失败：{item.get('title') or item['key']} —— {message}", "error"
                )
        except Exception as exc:  # noqa: BLE001
            self.state.mark_failed(item["key"], -1, str(exc), item.get("title", ""))
            self._counter["failed"] += 1
            self._consecutive_failures += 1
            self._log(f"失败：{item.get('title') or item['key']} —— {exc}", "error")
        else:
            self.state.mark("done", item["key"])
            self._counter["done"] += 1
            self._consecutive_failures = 0
            if self._counter["done"] % 20 == 0:
                self._log(f"已新增 {self._counter['done']} 条")

        if self._consecutive_failures >= max(1, self.opts.max_consecutive_failures):
            self.state.save()
            raise EngineStopped(
                f"连续失败 {self._consecutive_failures} 次，为避免账号被限制已自动停止。"
                f"请检查网络与登录态后重试（已完成的进度不会丢失）。"
            )

        self._processed_since_save += 1
        if self._processed_since_save >= max(1, int(self.opts.save_every)):
            self._processed_since_save = 0
            self.state.save()
        self._push_progress()
