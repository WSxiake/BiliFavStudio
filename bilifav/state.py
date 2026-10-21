# -*- coding: utf-8 -*-
"""
断点续传状态。

一次"复制任务"对应一个状态文件，里面冻结了：
  * 源收藏夹 / 目标收藏夹的身份；
  * 源收藏夹的完整条目清单（分页抓取一次后本地化，之后不再依赖线上顺序）；
  * 复制进度（已完成 / 重复 / 失效 / 失败）。

有了它，程序被关掉、断网、被风控打断之后，重新打开仍然能接着跑，
而不是从头再来一遍。
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def normalize_media(raw: Dict[str, Any]) -> Dict[str, Any]:
    """把接口返回的一条收藏记录压成状态文件里的一条精简记录。"""
    bvid = str(raw.get("bvid") or "").strip()
    avid = int(raw.get("id") or 0)
    title = str(raw.get("title") or "").strip()
    upper = ""
    up = raw.get("upper")
    if isinstance(up, dict):
        upper = str(up.get("name") or "").strip()
    attr = int(raw.get("attr") or 0)
    ctype = int(raw.get("type") or 2)

    # 失效判定：没有 bvid、attr 最低位为 1、或标题是失效占位标题
    invalid = (
        not bvid
        or bool(attr & 0x1)
        or "已失效" in title
        or title in ("", "已删除")
    )
    reason = ""
    if invalid:
        if not bvid:
            reason = "无 bvid"
        elif attr & 0x1:
            reason = f"attr={attr}"
        else:
            reason = "标题标记为已失效"

    return {
        "key": bvid or f"av{avid}",
        "avid": avid,
        "bvid": bvid,
        "type": ctype,
        "title": title,
        "upper": upper,
        "attr": attr,
        "invalid": invalid,
        "invalid_reason": reason,
    }


class CopyState:
    """单次复制任务的持久化状态。"""

    VERSION = 1

    def __init__(self, path: Path, data: Dict[str, Any]):
        self.path = Path(path)
        self.data = data
        self._lock = threading.RLock()
        self._dirty = False

    # ---------------- 构造 ----------------
    @classmethod
    def new(
        cls,
        path: Path,
        source: Dict[str, Any],
        target: Dict[str, Any],
        my_mid: int,
    ) -> "CopyState":
        data: Dict[str, Any] = {
            "version": cls.VERSION,
            "created_at": _now(),
            "updated_at": _now(),
            "my_mid": int(my_mid),
            "source": dict(source),
            "target": dict(target),
            "index": {
                "complete": False,
                "next_page": 1,
                "pages_fetched": 0,
                "items": [],
            },
            "progress": {
                "cursor": 0,
                "done": [],
                "duplicate": [],
                "invalid": [],
                "failed": [],
            },
        }
        state = cls(path, data)
        state.save()
        return state

    @classmethod
    def load(cls, path: Path) -> "CopyState":
        raw = Path(path).read_text(encoding="utf-8")
        data = json.loads(raw)
        if int(data.get("version", 0)) != cls.VERSION:
            raise ValueError(f"状态文件版本不兼容：{data.get('version')}")
        # 补齐可能缺失的字段，容忍手工编辑过的文件
        data.setdefault("index", {})
        data["index"].setdefault("items", [])
        data["index"].setdefault("next_page", 1)
        data["index"].setdefault("pages_fetched", 0)
        data["index"].setdefault("complete", False)
        prog = data.setdefault("progress", {})
        for k in ("done", "duplicate", "invalid", "failed"):
            prog.setdefault(k, [])
        prog.setdefault("cursor", 0)
        data.setdefault("source", {})
        data.setdefault("target", {})
        return cls(path, data)

    @classmethod
    def load_or_new(
        cls,
        path: Path,
        source: Dict[str, Any],
        target: Dict[str, Any],
        my_mid: int,
    ) -> "CopyState":
        """能复用就复用（断点续传），否则新建。"""
        path = Path(path)
        if path.exists():
            try:
                state = cls.load(path)
            except (OSError, ValueError, json.JSONDecodeError):
                state = None
            if state is not None and state.matches(source, target, my_mid):
                return state
        return cls.new(path, source, target, my_mid)

    def matches(self, source: Dict[str, Any], target: Dict[str, Any], my_mid: int) -> bool:
        try:
            return (
                int(self.data["source"].get("media_id", -1)) == int(source["media_id"])
                and int(self.data["target"].get("media_id", -1)) == int(target["media_id"])
                and int(self.data.get("my_mid", -1)) == int(my_mid)
            )
        except (KeyError, TypeError, ValueError):
            return False

    # ---------------- 持久化 ----------------
    def save(self) -> None:
        with self._lock:
            self.data["updated_at"] = _now()
            payload = json.dumps(self.data, ensure_ascii=False, separators=(",", ":"))
            tmp = self.path.with_name(self.path.name + ".tmp")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(payload, encoding="utf-8")
            os.replace(tmp, self.path)
            self._dirty = False

    # ---------------- 便捷访问 ----------------
    @property
    def items(self) -> List[Dict[str, Any]]:
        return self.data["index"]["items"]

    @property
    def progress(self) -> Dict[str, Any]:
        return self.data["progress"]

    def sets(self) -> Dict[str, Set[str]]:
        prog = self.progress
        return {
            "done": set(prog["done"]),
            "duplicate": set(prog["duplicate"]),
            "invalid": set(prog["invalid"]),
            "failed": {f.get("key") for f in prog["failed"]},
        }

    def add_index_items(self, items: List[Dict[str, Any]], seen: Set[str]) -> int:
        """追加索引条目，返回新增数量。"""
        added = 0
        for item in items:
            key = item["key"]
            if key in seen:
                continue
            seen.add(key)
            self.items.append(item)
            added += 1
        return added

    def mark(self, bucket: str, key: str) -> None:
        with self._lock:
            prog = self.progress
            if bucket != "failed" and key not in prog[bucket]:
                prog[bucket].append(key)

    def mark_failed(self, key: str, code: int, message: str, title: str = "") -> None:
        with self._lock:
            self.progress["failed"].append(
                {"key": key, "code": code, "msg": message, "title": title}
            )

    def clear_failed(self) -> None:
        """清空失败记录，让这些条目在下次运行时重试。"""
        with self._lock:
            self.progress["failed"] = []

    def summary(self) -> Dict[str, int]:
        prog = self.progress
        return {
            "total": len(self.items),
            "done": len(prog["done"]),
            "duplicate": len(prog["duplicate"]),
            "invalid": len(prog["invalid"]),
            "failed": len(prog["failed"]),
            "remaining": self.remaining_count(),
        }

    def remaining_count(self) -> int:
        total = len(self.items)
        marks = self.sets()
        finished = marks["done"] | marks["duplicate"] | marks["invalid"]
        return max(0, total - len(finished))

    def reset_progress(self) -> None:
        """只清进度，保留已抓取的清单（重来一遍复制，但不重新扫描）。"""
        with self._lock:
            self.data["progress"] = {
                "cursor": 0,
                "done": [],
                "duplicate": [],
                "invalid": [],
                "failed": [],
            }
        self.save()

    @staticmethod
    def state_path_for(state_dir: Path, source_media_id: int, target_media_id: int) -> Path:
        return Path(state_dir) / f"src{int(source_media_id)}_to_dst{int(target_media_id)}.json"

    def export_list(self, out_path: Path) -> Path:
        """把清单导出成 CSV（BV 号 / 标题 / UP 主 / 状态），方便留档核对。"""
        import csv

        marks = self.sets()
        out_path = Path(out_path)
        with out_path.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(["bvid", "avid", "type", "title", "upper", "status", "note"])
            for item in self.items:
                key = item["key"]
                if key in marks["done"]:
                    status, note = "已收藏", ""
                elif key in marks["duplicate"]:
                    status, note = "已存在", ""
                elif key in marks["invalid"]:
                    status, note = "已失效", item.get("invalid_reason", "")
                elif key in marks["failed"]:
                    hit = next(
                        (f for f in self.progress["failed"] if f.get("key") == key), {}
                    )
                    status, note = "失败", f"[{hit.get('code')}] {hit.get('msg', '')}"
                else:
                    status, note = "未处理", ""
                writer.writerow(
                    [
                        item.get("bvid", ""),
                        item.get("avid", ""),
                        item.get("type", ""),
                        item.get("title", ""),
                        item.get("upper", ""),
                        status,
                        note,
                    ]
                )
        return out_path
