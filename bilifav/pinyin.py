# -*- coding: utf-8 -*-
"""
内置拼音表：让中文标题能按拼音排序。

为什么要内置：用户的电脑上不一定有 pypinyin，而 Windows 的 locale 排序在不同
系统版本上表现不一致。排序是这个程序的核心功能之一，"中文标题按拼音排"属于
刚需，所以直接把常用汉字（CJK 基本区 20992 字）的拼音打包进来。

数据来源：mozillazg/pinyin-data 的 kMandarin（已去声调、只保留首读音），
由 tools/build_pinyin.py 压缩生成。文件约 104 KB，首次使用时懒加载。
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Dict, Optional

_START = 0x4E00  # 数据文件的第 0 行对应这个码位
_DATA_LINES = 2   # 前两行是 #start / #count 头

_lock = threading.Lock()
_table: Optional[Dict[str, str]] = None
_load_failed = False


def _data_path() -> Path:
    return Path(__file__).resolve().parent / "data" / "pinyin.txt"


def _ensure_loaded() -> Dict[str, str]:
    """懒加载拼音表，只读一次。失败就退回空表（排序时按码位兜底）。"""
    global _table, _load_failed
    if _table is not None:
        return _table
    with _lock:
        if _table is not None:
            return _table
        table: Dict[str, str] = {}
        if not _load_failed:
            try:
                text = _data_path().read_text(encoding="utf-8")
                for index, line in enumerate(text.split("\n")[_DATA_LINES:]):
                    line = line.strip()
                    if line:
                        table[chr(_START + index)] = line
            except OSError:
                _load_failed = True
        _table = table
        return table


def pinyin(char: str) -> str:
    """单个汉字的无声调拼音；没有数据时返回空串。"""
    return _ensure_loaded().get(char, "")


def sort_key(text: str) -> str:
    """
    把一段文本转成可用于排序的拼音串。

    非汉字字符原样保留（转小写），所以 "【教程】第2期" 会变成
    "【jiaocheng】di2qi" 这种，中英混排时表现自然。
    """
    if not text:
        return ""
    table = _ensure_loaded()
    parts = []
    for char in text:
        hit = table.get(char)
        if hit:
            parts.append(hit)
            parts.append(" ")  # 分隔音節，避免 "xi'an" 与 "xian" 混淆
        else:
            parts.append(char.lower())
    return "".join(parts)


def available() -> bool:
    """拼音表是否可用（界面上据此决定要不要给"按标题"排序加拼音选项）。"""
    return bool(_ensure_loaded())


def stats() -> Dict[str, int]:
    table = _ensure_loaded()
    size = 0
    try:
        size = _data_path().stat().st_size
    except OSError:
        pass
    return {"chars": len(table), "bytes": size}
