# -*- coding: utf-8 -*-
"""
登录态本地持久化。

注意：这里落盘的是你自己的登录 Cookie（相当于登录凭证）。
文件只存在本机程序目录下，程序不会把它发往除 bilibili.com 以外的任何地方。
不需要时点界面上的"退出登录"即可删除。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional

import requests

from .paths import session_file

# 只持久化这几个与登录相关的 Cookie
KEEP = ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid", "buvid3", "buvid4")


def save_session(session: requests.Session, path: Optional[Path] = None) -> None:
    path = Path(path or session_file())
    cookies = []
    for name in KEEP:
        value = session.cookies.get(name)
        if value:
            cookies.append({"name": name, "value": value})
    payload = {"version": 1, "cookies": cookies}
    tmp = path.with_name(path.name + ".tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    try:  # 顺手收紧权限（Windows 上基本是 no-op，Linux/macOS 有效）
        path.chmod(0o600)
    except OSError:
        pass


def load_session(session: requests.Session, path: Optional[Path] = None) -> bool:
    path = Path(path or session_file())
    if not path.exists():
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    cookies: List[dict] = payload.get("cookies") or []
    loaded = False
    for entry in cookies:
        name = entry.get("name")
        value = entry.get("value")
        if name and value:
            session.cookies.set(name, value, domain=".bilibili.com", path="/")
            loaded = True
    return loaded


def clear_session(path: Optional[Path] = None) -> None:
    path = Path(path or session_file())
    try:
        path.unlink()
    except OSError:
        pass


def session_path() -> Path:
    return session_file()
