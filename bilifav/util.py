# -*- coding: utf-8 -*-
"""零散的小工具：收藏夹 ID 解析、错误归类、格式化。"""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

from .api import BiliError

# 复制条目时的结果分类
OK = "ok"
DUP = "dup"
INVALID = "invalid"
FAIL = "fail"
FATAL = "fatal"

# 目标收藏夹满了 —— 属于必须停下来人工处理的情况
_FULL_HINTS = ("收藏夹已满", "已满", "达到上限", "超出上限", "上限")
_FULL_CODES = {10005, 10011, 10012}

# 已经收藏过 —— 当作成功处理
_DUP_HINTS = ("已经收藏", "已收藏", "重复收藏", "已经存在", "已存在")
_DUP_CODES = {10009}

# 稿件本身不可用 —— 跳过并记档
_INVALID_HINTS = (
    "已失效",
    "不存在",
    "不可用",
    "已被删除",
    "稿件不可见",
    "无法收藏",
    "啥都木有",
    "参数错误",
    "稿件审核中",
)
_INVALID_CODES = {10003, 62002, 62004, -404}

_FATAL_HINTS = ("权限不足", "没有权限", "访问权限")
_FATAL_CODES = {-403, 10001}


def classify_fav_error(exc: BiliError) -> Tuple[str, str]:
    """把收藏接口的报错归类成 (类别, 人话说明)。"""
    code = int(getattr(exc, "code", -1))
    msg = str(getattr(exc, "message", "") or "")

    if code in _FULL_CODES or any(h in msg for h in _FULL_HINTS):
        return FATAL, f"目标收藏夹已满（{msg or code}）"
    if code in _DUP_CODES or any(h in msg for h in _DUP_HINTS):
        return DUP, msg or "已经收藏过了"
    if code in _INVALID_CODES or any(h in msg for h in _INVALID_HINTS):
        return INVALID, msg or "稿件不可用"
    if code in _FATAL_CODES or any(h in msg for h in _FATAL_HINTS):
        return FATAL, msg or "没有权限"
    return FAIL, f"[{code}] {msg}"


_ID_PATTERNS = (
    re.compile(r"[?&]fid=(\d+)"),
    re.compile(r"/ml(\d+)"),
    re.compile(r"media_id=(\d+)"),
    re.compile(r"\bml(\d+)\b"),
)


def parse_media_id(text: str) -> Optional[int]:
    """
    从用户输入里抠出收藏夹 ID。

    支持：完整链接、带 fid 的 favlist 链接、ml 开头的短链、纯数字。
    """
    if not text:
        return None
    raw = str(text).strip()
    if not raw:
        return None
    if raw.isdigit():
        value = int(raw)
        return value if value > 0 else None
    for pattern in _ID_PATTERNS:
        hit = pattern.search(raw)
        if hit:
            value = int(hit.group(1))
            if value > 0:
                return value
    # 最后兜底：链接里最长的一段纯数字
    numbers = [int(n) for n in re.findall(r"\d{3,}", raw)]
    if numbers:
        return max(numbers)
    return None


def human_count(n: int) -> str:
    n = int(n or 0)
    if n >= 10000:
        return f"{n / 10000:.1f}万"
    return str(n)


# --------------------------------------------------------------------------
# 视频标识解析（"添加视频"功能要用）
# --------------------------------------------------------------------------
# BV 号固定 12 位：BV + 10 位 base58
_BV_RE = re.compile(r"BV[0-9A-Za-z]{10}")
_AV_RE = re.compile(r"av(\d{1,12})", re.IGNORECASE)
# 收藏条目在程序内部统一写成 "{id}:{type}"，比如 "12345:2"
_KEY_RE = re.compile(r"^(\d{1,15}):(\d{1,3})$")


def parse_video_ids(text: str) -> Tuple[List[str], List[int]]:
    """
    从用户粘贴的一坨文本里，把所有视频标识都抠出来。

    支持 BV 号、av 号，链接里的也能认；自动去重并保持出现顺序。
    返回 (BV 号列表, av 号列表)。
    """
    if not text:
        return [], []

    raw = str(text)
    bvids: List[str] = []
    seen_bv = set()
    for hit in _BV_RE.findall(raw):
        if hit not in seen_bv:
            seen_bv.add(hit)
            bvids.append(hit)

    avids: List[int] = []
    seen_av = set()
    for hit in _AV_RE.findall(raw):
        value = int(hit)
        if value and value not in seen_av:
            seen_av.add(value)
            avids.append(value)

    return bvids, avids


def parse_item_key(key: str) -> Optional[Tuple[int, int]]:
    """把 "12345:2" 解析成 (12345, 2)；格式不对返回 None。"""
    hit = _KEY_RE.match(str(key or "").strip())
    if not hit:
        return None
    return int(hit.group(1)), int(hit.group(2))


def format_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"
