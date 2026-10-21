# -*- coding: utf-8 -*-
"""
顺序整理引擎。

===== 先说清楚 B 站这个接口的脾气 =====

调整收藏夹顺序的接口是 POST /x/v3/fav/resource/sort，它**不收完整列表**，
收的是「移动操作序列」。单个操作长这样：

      {参照条目id}:{参照类型}:{被移动条目id}:{被移动类型}

含义是「把被移动的条目挪到参照条目的后面」；参照写成 `0:0` 表示挪到最前面。
多个操作用逗号相连，服务端按顺序依次执行。

例：`456:2:123:2`  ==  把 av123 挪到 av456 后面。

这一点如果理解成"提交排好序的完整列表"，接口会直接报错，或者顺序完全乱掉。

===== 于是这个模块要做的事 =====

用户在界面上拖来拖去，最终只是得到一个新顺序（target）。我们要把它翻译成
一串移动操作，让服务端照着做一遍，最后得到同样的顺序。

算法（模拟插入排序，保证前 i 个位置逐步就位）：

    cur = 原顺序
    对 i = 0 .. n-1:
        如果 cur[i] 已经是 target[i]，跳过
        否则把 target[i] 从它现在的位置挪到 i 上，
        操作数 +1，并同步更新 cur

每一步都让"前 i 个位置"与目标一致，归纳下去最终整体一致。
最坏情况要 n-1 次操作（比如整体反转），但这是接口语义决定的下限。

===== 为什么还要分批 =====

一次塞几千个操作进去，字符串能到几十 KB，服务端执行也慢，容易被风控盯上。
所以按 batch_size 切开逐批提交，每批之间照常限速，并且随时可以中止。
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from .api import BiliClient, BiliError, Cancelled, NotLoggedInError, RiskControlError
from .pinyin import sort_key as pinyin_sort_key
from .util import DUP, FATAL, INVALID, classify_fav_error, parse_item_key

# 空参照：挪到最前面
FRONT = "0:0"


# --------------------------------------------------------------------------
# 条目归一化
# --------------------------------------------------------------------------
def item_key(raw: Dict[str, Any]) -> str:
    """条目的唯一标识：`{id}:{type}`，与接口要求的格式一致。"""
    return f"{int(raw.get('id') or raw.get('avid') or 0)}:{int(raw.get('type') or 2)}"


def normalize_item(raw: Dict[str, Any]) -> Dict[str, Any]:
    """把接口返回的一条收藏记录整理成界面好用的结构。"""
    upper = raw.get("upper") if isinstance(raw.get("upper"), dict) else {}
    cnt = raw.get("cnt_info") if isinstance(raw.get("cnt_info"), dict) else {}
    title = str(raw.get("title") or "").strip()
    upper_name = str(upper.get("name") or "").strip()
    attr = int(raw.get("attr") or 0)

    def _num(value: Any) -> int:
        try:
            return int(value or 0)
        except (TypeError, ValueError):
            return 0

    return {
        "key": item_key(raw),
        "avid": _num(raw.get("id")),
        "type": _num(raw.get("type")) or 2,
        "bvid": str(raw.get("bvid") or raw.get("bv_id") or ""),
        "title": title,
        "upper": upper_name,
        "upper_info": {"mid": _num(upper.get("mid")), "name": upper_name,
                       "face": str(upper.get("face") or "")},
        "duration": _num(raw.get("duration")),
        "pubtime": _num(raw.get("pubtime")) or _num(raw.get("ctime")),
        "fav_time": _num(raw.get("fav_time")),
        "play": _num(cnt.get("play")),
        "danmaku": _num(cnt.get("danmaku")),
        "collect": _num(cnt.get("collect")),
        "cover": str(raw.get("cover") or ""),
        # attr 低位为 1 或等于 9 都表示稿件已失效（UP 自删 / 其他原因删除）
        "invalid": bool(attr & 0x1) or attr == 9,
        # 前端拿它做中文按拼音排序，省得每次排序都回来问后端
        "py": pinyin_sort_key(title),
        "py_upper": pinyin_sort_key(upper_name),
    }


def normalize_items(raws: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for raw in raws:
        if isinstance(raw, dict):
            out.append(normalize_item(raw))
    return out


# --------------------------------------------------------------------------
# 核心：顺序 → 移动操作序列
# --------------------------------------------------------------------------
def build_move_ops(original: Sequence[str], target: Sequence[str]) -> List[Tuple[Optional[str], str]]:
    """
    推导「把 original 变成 target」所需的移动操作。

    返回 [(参照key 或 None, 被移动key), ...]，参照为 None 表示移到最前面。
    只移动真正需要动的条目；顺序没变时返回空列表。
    """
    cur = [k for k in original]
    ops: List[Tuple[Optional[str], str]] = []

    for index, want in enumerate(target):
        if index >= len(cur):
            break
        if cur[index] == want:
            continue
        try:
            # 前 index 个位置已经就位，所以 want 一定在 index 及其后面
            where = cur.index(want, index)
        except ValueError:
            # target 里出现了 original 中不存在的条目，跳过它更安全
            continue
        before = cur[index - 1] if index > 0 else None
        ops.append((before, want))
        item = cur.pop(where)
        cur.insert(index, item)

    return ops


def pack_ops(ops: Sequence[Tuple[Optional[str], str]]) -> str:
    """把操作序列打包成接口要求的字符串。"""
    return ",".join(f"{before or FRONT}:{moved}" for before, moved in ops)


def diff_summary(original: Sequence[str], target: Sequence[str]) -> Dict[str, int]:
    """给界面看的对比信息：有多少条动了位置。"""
    total = len(target)
    same = sum(1 for a, b in zip(original, target) if a == b)
    return {
        "total": total,
        "moved": build_move_ops(original, target).__len__(),
        "unchanged": same,
    }


# --------------------------------------------------------------------------
# 提交任务
# --------------------------------------------------------------------------
class SortCancelled(Exception):
    """用户中止了提交。"""


class SortApplier:
    """
    把一轮顺序调整提交给 B 站。

    逐批提交，每批之间照常限速；任意时刻都能中止，已提交的批次不会回滚
    （接口本身也不支持回滚），但会如实告诉用户停在哪一步。
    """

    def __init__(
        self,
        client: BiliClient,
        emit: Callable[[Dict[str, Any]], None],
        batch_size: int = 200,
    ):
        self.client = client
        self.emit = emit
        self.batch_size = max(1, int(batch_size))
        self.stop_flag = threading.Event()
        # 提交前后的顺序快照，成功后交给上层写进 data/history/（给"回滚"用）
        self.before_keys: List[str] = []
        self.after_keys: List[str] = []
        client.set_cancel(self.stop_flag)

    def stop(self) -> None:
        self.stop_flag.set()

    def _event(self, kind: str, **payload: Any) -> None:
        payload["type"] = kind
        try:
            self.emit(payload)
        except Exception:
            pass

    def _log(self, text: str, level: str = "info") -> None:
        self._event("log", level=level, text=text)

    # ---------------- 辅助 ----------------
    def _fetch_keys(self, media_id: int) -> List[str]:
        """
        把收藏夹当前的条目按真实顺序拉一遍（只看 key）。

        这里**不能用**那个一次拿完的 ids 接口。实测（945 条的收藏夹）：
        ids 会多返回几条"已失效但还占着位置"的条目 —— 逐页拉详情会把这些
        过滤掉，于是条数对不上（945 vs 942），后面的位置整体错位一格。
        拿这个结果去算增量移动，会把顺序算歪，还会误报"收藏夹被改过了"。

        所以老老实实逐页拉，只把限速调松一点。
        """
        with self.client.faster(0.5):
            raws = self.client.fav_resource_all(media_id, order="mtime")
        return [item_key(raw) for raw in raws]

    def _do_deletions(self, media_id: int, deletions: Sequence[str]) -> Optional[Dict[str, Any]]:
        """先做删除。全部成功返回 None，否则返回中止原因。"""
        resources: List[Tuple[int, int]] = []
        for key in deletions:
            hit = parse_item_key(key)
            if hit:
                resources.append(hit)
            else:
                self._log(f"看不懂这条的编号，跳过：{key}", "warn")
        if not resources:
            return None

        total = len(resources)
        self._event("sort_stage", stage="delete", done=0, total=total)
        self._log(f"第 1 步：从收藏夹里删掉 {total} 条")

        # 删除接口单次别塞太多，30 条一批很稳
        chunk_size = 30
        chunks = [resources[i:i + chunk_size] for i in range(0, total, chunk_size)]
        done = 0
        for index, chunk in enumerate(chunks, start=1):
            if self.stop_flag.is_set():
                return {"ok": False, "reason": "cancelled",
                        "message": f"删除进行到 {done}/{total} 时被中止"}
            try:
                self.client.fav_batch_del(media_id, chunk)
            except RiskControlError as exc:
                return {"ok": False, "reason": "risk", "message": f"删除时触发风控：{exc.message}"}
            except NotLoggedInError as exc:
                return {"ok": False, "reason": "auth", "message": exc.message}
            except BiliError as exc:
                return {"ok": False, "reason": "api",
                        "message": f"删除失败（第 {index} 批）：{exc}"}
            done += len(chunk)
            self._event("sort_stage", stage="delete", done=done, total=total)
            self._log(f"已删除 {done}/{total} 条")

        return None

    def _do_additions(self, media_id: int, additions: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """再做添加。返回被跳过的条目 key 集合（顺便也用于后续对齐）。"""
        self.skipped_additions = set()
        # B 站收藏接口是"新加的排最前面"，照清单顺序加的话最后会是倒的。
        # 反过来加，每加一条往前顶一次，收工正好是原顺序。
        additions = list(reversed(list(additions)))
        total = len(additions)
        self._event("sort_stage", stage="add", done=0, total=total)
        self._log(f"第 2 步：往收藏夹里添加 {total} 条")

        for index, item in enumerate(additions, start=1):
            if self.stop_flag.is_set():
                return {"ok": False, "reason": "cancelled",
                        "message": f"添加进行到 {index - 1}/{total} 时被中止"}

            label = str(item.get("title") or item.get("bvid") or item.get("avid") or "?")
            avid = int(item.get("avid") or 0)
            ctype = int(item.get("type") or 2)
            bvid = str(item.get("bvid") or "")

            # 只有 BV 号的时候先查一下 avid：收藏接口要的是 avid
            if not avid and bvid:
                try:
                    detail = self.client.video_detail(bvid=bvid)
                except BiliError as exc:
                    self._log(f"查不到 {bvid}（{exc.message}），跳过", "warn")
                    self.skipped_additions.add(str(item.get("key") or ""))
                    self._event("sort_stage", stage="add", done=index, total=total)
                    continue
                avid = int(detail.get("aid") or 0)
                if not avid:
                    self._log(f"{bvid} 拿不到 avid，跳过", "warn")
                    self.skipped_additions.add(str(item.get("key") or ""))
                    self._event("sort_stage", stage="add", done=index, total=total)
                    continue

            if not avid:
                self._log(f"{label} 没有可用的编号，跳过", "warn")
                self.skipped_additions.add(str(item.get("key") or ""))
                self._event("sort_stage", stage="add", done=index, total=total)
                continue

            try:
                self.client.fav_deal(avid, add_media_ids=[media_id], content_type=ctype)
                self._log(f"已添加：{label}")
            except RiskControlError as exc:
                return {"ok": False, "reason": "risk", "message": f"添加时触发风控：{exc.message}"}
            except NotLoggedInError as exc:
                return {"ok": False, "reason": "auth", "message": exc.message}
            except BiliError as exc:
                kind, message = classify_fav_error(exc)
                if kind == DUP:
                    self._log(f"这条本来就在收藏夹里：{label}", "warn")
                elif kind == INVALID:
                    self._log(f"稿件已不可用，跳过：{label}", "warn")
                    self.skipped_additions.add(str(item.get("key") or ""))
                elif kind == FATAL:
                    return {"ok": False, "reason": "api", "message": f"{label}：{message}"}
                else:
                    self._log(f"添加失败：{label} —— {message}", "error")
                    self.skipped_additions.add(str(item.get("key") or ""))

            self._event("sort_stage", stage="add", done=index, total=total)

        return None

    # ---------------- 主流程 ----------------
    def run(
        self,
        media_id: int,
        original: Sequence[str],
        target: Sequence[str],
        deletions: Sequence[str] = (),
        additions: Sequence[Dict[str, Any]] = (),
    ) -> Dict[str, Any]:
        """
        提交一轮改动，顺序是：先删、再添、最后排。

        为什么能一口气做完：增删之后会**重新拉一遍真实顺序**，再基于它算增量移动。
        这样无论 B 站把新收藏塞在最前面还是别的地方，最终顺序都跟界面上看到的一致。
        """
        if not self.client.csrf:
            return {"ok": False, "reason": "auth", "message": "登录态已失效，请重新登录后再提交"}

        deletions = list(deletions)
        additions = [dict(a) for a in additions]
        self.skipped_additions: set = set()
        note: List[str] = []

        # ---- 第 1 步：删除 ----
        if deletions:
            abort = self._do_deletions(media_id, deletions)
            if abort:
                return abort
        else:
            self._event("sort_stage", stage="delete", done=0, total=0)

        # ---- 第 2 步：添加 ----
        if additions:
            abort = self._do_additions(media_id, additions)
            if abort:
                return abort
        else:
            self._event("sort_stage", stage="add", done=0, total=0)

        # ---- 第 3 步：确定"现在"的真实顺序 ----
        if deletions or additions:
            self._log("第 3 步：重新读一遍收藏夹，确认当前顺序")
            try:
                current = self._fetch_keys(media_id)
            except Cancelled:
                return {"ok": False, "reason": "cancelled", "message": "重新读取时被中止"}
            except BiliError as exc:
                return {"ok": False, "reason": "api",
                        "message": f"增删都做完了，但重新读取失败：{exc}。请手动刷新看看结果。"}
            self._log(f"当前线上共 {len(current)} 条")
        else:
            current = list(original)

        # ---- 第 4 步：把两边对齐 ----
        wanted = [k for k in target if k]
        current_set = set(current)
        wanted_set = set(wanted)

        if not (deletions or additions):
            # 纯排序：两边必须严格一致。不一致说明界面上那份是过期数据，
            # 硬提交只会把顺序搞乱，不如直接拒绝、让用户重新加载。
            stale = [k for k in current if k not in wanted_set]
            if stale:
                return {
                    "ok": False,
                    "reason": "mismatch",
                    "message": f"有 {len(stale)} 条不在提交列表里，收藏夹多半被改过了。"
                               f"重新加载一下再试吧。",
                }
        else:
            # 有增删的时候，两边有点出入是正常的（比如某个视频就是加不进去），
            # 这里做宽容对齐，并把发生了什么如实告诉用户。
            ghost = [k for k in wanted if k not in current_set]
            if ghost:
                wanted = [k for k in wanted if k in current_set]
                note.append(f"{len(ghost)} 条没能在收藏夹里确认到，已从本次排列中排除")

            extra = [k for k in current if k not in wanted_set]
            if extra:
                wanted = wanted + extra
                note.append(f"{len(extra)} 条是这次新出现的，已排到末尾")

        for text in note:
            self._log(text, "warn")

        # 记下"改动前"和"改完"的顺序。上面那几条 return 路径都从这里之后走，
        # 所以只要在这一处赋值，所有成功/半成功的出口都能拿到 ——
        # 「回滚上次提交」就是靠这一对快照把顺序倒回去的。
        self.before_keys = list(current)
        self.after_keys = list(wanted)

        if not wanted:
            self._log("没有需要排列的内容了", "ok")
            return {"ok": True, "reason": "finished", "ops": 0, "batches": 0,
                    "deleted": len(deletions), "added": len(additions), "notes": note}

        # ---- 第 5 步：算增量移动并分批提交 ----
        ops = build_move_ops(current, wanted)
        self._event("sort_stage", stage="sort", done=0, total=len(ops))

        if not ops:
            # 只是排序、顺序又没变 → noop；
            # 有增删、只是恰好不用再挪 → 那也算完成了
            changed = bool(deletions or additions)
            self._log("增删完成，顺序不用再动" if changed else "顺序没有变化，不需要移动", "ok")
            return {
                "ok": True, "reason": "finished" if changed else "noop",
                "ops": 0, "batches": 0,
                "deleted": len(deletions), "added": len(additions), "notes": note,
            }

        total_ops = len(ops)
        batches = [ops[i:i + self.batch_size] for i in range(0, total_ops, self.batch_size)]
        self._log(
            f"第 4 步：需要 {total_ops} 次移动，分 {len(batches)} 批提交"
            f"（每批 {self.batch_size} 次）"
        )
        self._event("sort_start", ops=total_ops, batches=len(batches))

        done_ops = 0
        try:
            for index, batch in enumerate(batches, start=1):
                if self.stop_flag.is_set():
                    raise SortCancelled()
                payload = pack_ops(batch)
                try:
                    self.client.fav_resource_sort(media_id, payload)
                except RiskControlError as exc:
                    self._log(
                        f"触发风控：{exc.message}。已停在第 {index - 1} 批，"
                        f"前面的调整已经生效，建议等 30 分钟后再继续。",
                        "error",
                    )
                    return {
                        "ok": False, "reason": "risk", "ops": done_ops,
                        "batches": index - 1, "message": exc.message, "notes": note,
                    }
                except NotLoggedInError as exc:
                    self._log(f"登录态失效：{exc.message}", "error")
                    return {
                        "ok": False, "reason": "auth", "ops": done_ops,
                        "batches": index - 1, "message": exc.message, "notes": note,
                    }
                except BiliError as exc:
                    self._log(f"第 {index} 批提交失败：{exc}", "error")
                    return {
                        "ok": False, "reason": "api", "ops": done_ops,
                        "batches": index - 1, "message": str(exc), "notes": note,
                    }

                done_ops += len(batch)
                self._event(
                    "sort_progress",
                    done=done_ops, total=total_ops,
                    batch=index, batches=len(batches),
                )
                self._event("sort_stage", stage="sort", done=done_ops, total=total_ops)
                self._log(f"第 {index}/{len(batches)} 批已提交（累计 {done_ops}/{total_ops} 次移动）")

        except SortCancelled:
            self._log(f"已中止，{done_ops}/{total_ops} 次移动已生效", "warn")
            return {"ok": False, "reason": "cancelled", "ops": done_ops,
                    "batches": 0, "notes": note}

        summary = []
        if deletions:
            summary.append(f"删除 {len(deletions)} 条")
        if additions:
            summary.append(f"添加 {len(additions)} 条")
        summary.append(f"移动 {done_ops} 次")
        self._log("全部完成：" + "、".join(summary), "ok")
        return {"ok": True, "reason": "finished", "ops": done_ops,
                "batches": len(batches), "deleted": len(deletions),
                "added": len(additions), "notes": note}


# --------------------------------------------------------------------------
# 智能排序策略（服务端算一份，方便接口/命令行复用）
# --------------------------------------------------------------------------
SORT_STRATEGIES: Dict[str, Dict[str, str]] = {
    "fav_time_desc": {"label": "收藏时间 ↓ 最新在前", "field": "fav_time", "desc": "1"},
    "fav_time_asc": {"label": "收藏时间 ↑ 最早在前", "field": "fav_time", "desc": "0"},
    "pubtime_desc": {"label": "投稿时间 ↓ 新投稿在前", "field": "pubtime", "desc": "1"},
    "pubtime_asc": {"label": "投稿时间 ↑ 老投稿在前", "field": "pubtime", "desc": "0"},
    "title_asc": {"label": "标题 A→Z（按拼音）", "field": "py", "desc": "0"},
    "title_desc": {"label": "标题 Z→A（按拼音）", "field": "py", "desc": "1"},
    "upper_asc": {"label": "UP 主 A→Z（按拼音）", "field": "py_upper", "desc": "0"},
    "upper_desc": {"label": "UP 主 Z→A（按拼音）", "field": "py_upper", "desc": "1"},
    "play_desc": {"label": "播放量 ↓ 高播放在前", "field": "play", "desc": "1"},
    "play_asc": {"label": "播放量 ↑ 低播放在前", "field": "play", "desc": "0"},
    "danmaku_desc": {"label": "弹幕数 ↓ 多弹幕在前", "field": "danmaku", "desc": "1"},
    "collect_desc": {"label": "收藏数 ↓ 高收藏在前", "field": "collect", "desc": "1"},
    "duration_asc": {"label": "时长 ↑ 短的在前", "field": "duration", "desc": "0"},
    "duration_desc": {"label": "时长 ↓ 长的在前", "field": "duration", "desc": "1"},
}


def apply_strategy(items: Sequence[Dict[str, Any]], strategy: str) -> List[str]:
    """
    按策略算出一份新顺序（返回 key 列表）。

    界面上的实时预览是自己算的，这里这份实现主要给接口与脚本复用，
    两边保持一致的排序语义。
    """
    keys = [it["key"] for it in items]

    if strategy == "reverse":
        return list(reversed(keys))
    if strategy == "invalid_last":
        bad = [it["key"] for it in items if it.get("invalid")]
        good = [it["key"] for it in items if not it.get("invalid")]
        return good + bad
    if strategy == "invalid_first":
        bad = [it["key"] for it in items if it.get("invalid")]
        good = [it["key"] for it in items if not it.get("invalid")]
        return bad + good

    spec = SORT_STRATEGIES.get(strategy)
    if not spec:
        return keys

    field = spec["field"]
    reverse = spec["desc"] == "1"
    # 稳定的二级排序：主字段相同的时候，按原顺序保持不动
    ordered = sorted(
        enumerate(items),
        key=lambda pair: (pair[1].get(field) or "", pair[0]) if isinstance(pair[1].get(field), str)
        else (pair[1].get(field) or 0, pair[0]),
        reverse=reverse,
    )
    return [it["key"] for _, it in ordered]
