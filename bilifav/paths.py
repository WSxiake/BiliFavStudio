# -*- coding: utf-8 -*-
"""应用目录解析：优先便携模式（数据放在程序旁边），不可写时退回用户目录。"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def app_root() -> Path:
    """程序根目录。打包成 exe 后是 exe 所在目录，否则是包的上层目录。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def resource_root() -> Path:
    """
    只读资源（网页、拼音表）所在目录。

    PyInstaller 单文件模式会把资源解压到 sys._MEIPASS，这里一并兼容。
    """
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        candidate = Path(bundled) / "bilifav"
        if candidate.is_dir():
            return candidate
        return Path(bundled)
    return Path(__file__).resolve().parent


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def data_root() -> Path:
    """
    可写的数据根目录。

    **永远优先程序旁边的 data/** —— 登录态、任务存档、草稿、导出、日志、
    界面偏好全都在这儿，不往 C 盘或"文档"里另开目录。
    只有程序目录真的写不进去（比如装进了 Program Files 又没给权限）才会退回
    用户目录，而且 `data_root_is_portable()` 会返回 False，界面会明确提示一句。
    """
    portable = app_root() / "data"
    if _writable(portable):
        return portable
    fallback = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "BiliFavCopy"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def data_root_is_portable() -> bool:
    """数据是不是老老实实待在程序旁边的 data/ 里。"""
    try:
        return data_root() == app_root() / "data"
    except OSError:
        return False


def state_dir() -> Path:
    d = data_root() / "state"
    d.mkdir(parents=True, exist_ok=True)
    return d


def log_dir() -> Path:
    d = data_root() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def config_dir() -> Path:
    d = data_root() / "config"
    d.mkdir(parents=True, exist_ok=True)
    return d


def draft_dir() -> Path:
    """整理页的草稿（没提交的顺序 / 删除标记 / 新增项）。"""
    d = data_root() / "drafts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def export_dir() -> Path:
    """导出的清单 / 表格落在这儿。"""
    d = data_root() / "exports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def history_dir() -> Path:
    """
    每次**提交**都要在这儿留一份"改动前后的顺序"。

    「撤销一步」只在没提交时管用；提交之后要是发现排错了，
    就得靠这份记录把顺序倒回去。
    """
    d = data_root() / "history"
    d.mkdir(parents=True, exist_ok=True)
    return d


def prefs_file() -> Path:
    """
    界面偏好（收藏夹顺序、自定义快捷键…）。

    跟登录态那些不一样，这些丢了不致命，但放在 data/ 下面才能跟着一起搬走 ——
    放浏览器存储里的话，换台电脑就没了。
    """
    return config_dir() / "prefs.json"


def session_file() -> Path:
    return config_dir() / "session.json"


def cache_dir() -> Path:
    """
    收藏夹内容的缓存。

    来回切收藏夹时不用每次重读 —— B 站那个接口每页只给 39 条，
    945 条的收藏夹要翻 25 页，等 8 秒。读一次存下来，下次先铺上。
    """
    d = data_root() / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d
