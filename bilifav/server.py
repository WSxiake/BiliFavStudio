# -*- coding: utf-8 -*-
"""
本地 HTTP 服务：给界面提供 REST 接口，并托管静态页面。

安全上做了三件事（本地服务同样需要防着点）：
  1. 只绑定 127.0.0.1，外网访问不到；
  2. 每个请求都要带启动时随机生成的 token，其它网页猜不到；
  3. 校验 Origin / Referer，必须是本机同源。

任务模型：同一时刻只跑一个后台任务（复制或整理顺序），进度通过带序号的
事件队列推给界面，界面按序号拉增量，不会丢日志也不会重复刷屏。
"""
from __future__ import annotations

import csv
import json
import mimetypes
import os
import re
import secrets
import threading
import time
import traceback
import webbrowser
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import requests

from . import __version__
from .api import (
    BiliClient,
    BiliError,
    Cancelled,
    NotLoggedInError,
    RiskControlError,
)
from .engine import CopyEngine, CopyOptions
from .paths import (
    cache_dir,
    data_root,
    data_root_is_portable,
    draft_dir,
    export_dir,
    history_dir,
    log_dir,
    prefs_file,
    resource_root,
    state_dir,
)
from .pinyin import sort_key as pinyin_sort_key
from .pinyin import stats as pinyin_stats
from .session import clear_session, load_session, save_session
from .system_theme import system_theme
from .sorter import (
    SORT_STRATEGIES,
    SortApplier,
    build_move_ops,
    normalize_item,
    normalize_items,
)
from .state import CopyState
from .util import human_count, parse_media_id, parse_video_ids

WEB_DIR = resource_root() / "web"
DEFAULT_HOST = "127.0.0.1"
# 端口默认交给操作系统分配（0 = 随机挑一个空闲的）。
# 只有用户显式指定端口时才会从指定值开始往后找。
DEFAULT_PORT = 0
MAX_EVENTS = 4000


# ==========================================================================
# 共享的 B 站客户端
# ==========================================================================
class BiliContext:
    """全局共享一个 requests.Session，登录态在复制与整理之间通用。"""

    def __init__(self) -> None:
        self.session = requests.Session()
        self.client = BiliClient(session=self.session, delay=1.2, jitter=0.5)
        self._lock = threading.RLock()
        self._loaded = False

    def ensure_loaded(self) -> bool:
        with self._lock:
            if not self._loaded:
                load_session(self.session)
                self._loaded = True
        return self.client.has_session

    def persist(self) -> None:
        with self._lock:
            save_session(self.session)

    def forget(self) -> None:
        with self._lock:
            clear_session()
            self.client.clear_login()
            self._loaded = True


CTX = BiliContext()


# ==========================================================================
# 任务中心
# ==========================================================================
class TaskHub:
    """单任务调度 + 事件队列。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._events: deque = deque(maxlen=MAX_EVENTS)
        self._seq = 0
        self._thread: Optional[threading.Thread] = None
        self._controller: Any = None
        self._kind = ""
        self._label = ""
        self._state = "idle"
        self._result: Dict[str, Any] = {}
        self._extra: Dict[str, Any] = {}
        self._started_at = 0.0
        self._ended_at = 0.0

    # ---------------- 事件 ----------------
    def emit(self, event: Dict[str, Any]) -> None:
        with self._lock:
            self._seq += 1
            event = dict(event)
            event["seq"] = self._seq
            event["ts"] = time.time()
            self._events.append(event)
            if event.get("type") == "state":
                self._state = str(event.get("state") or self._state)

    def log(self, text: str, level: str = "info") -> None:
        self.emit({"type": "log", "level": level, "text": text})

    # ---------------- 状态 ----------------
    @property
    def busy(self) -> bool:
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def snapshot(self, since: int = 0) -> Dict[str, Any]:
        with self._lock:
            events = [e for e in self._events if int(e.get("seq", 0)) > since]
            return {
                "kind": self._kind,
                "label": self._label,
                "state": self._state,
                "busy": self.busy,
                "seq": self._seq,
                "events": events,
                "result": dict(self._result),
                "extra": dict(self._extra),
                "started_at": self._started_at,
                "ended_at": self._ended_at,
                "elapsed": int((self._ended_at or time.time()) - self._started_at)
                if self._started_at else 0,
                "can_pause": self._controller is not None and hasattr(self._controller, "pause"),
            }

    def update_extra(self, **kwargs: Any) -> None:
        with self._lock:
            self._extra.update(kwargs)

    # ---------------- 控制 ----------------
    def start(self, kind: str, label: str, work: Callable[["TaskHub"], Dict[str, Any]]) -> Tuple[bool, str]:
        with self._lock:
            if self.busy:
                return False, "已经有一个任务在跑了，等它结束或者先停掉它吧"
            self._kind = kind
            self._label = label
            self._state = "running"
            self._result = {}
            self._extra = {}
            self._controller = None
            self._started_at = time.time()
            self._ended_at = 0.0
            self._events.clear()
            self._seq = 0

        def runner() -> None:
            outcome: Dict[str, Any] = {}
            try:
                outcome = work(self) or {}
            except Cancelled:
                outcome = {"ok": False, "reason": "cancelled", "message": "已停止"}
            except RiskControlError as exc:
                self.log(f"触发 B 站风控：{exc.message}", "error")
                outcome = {"ok": False, "reason": "risk", "message": exc.message}
            except NotLoggedInError as exc:
                self.log(f"登录态失效：{exc.message}", "error")
                outcome = {"ok": False, "reason": "auth", "message": exc.message}
            except BiliError as exc:
                self.log(f"接口报错：{exc}", "error")
                outcome = {"ok": False, "reason": "api", "message": str(exc)}
            except Exception as exc:  # noqa: BLE001 - 兜底，绝不让线程静默死掉
                self.log(f"意外错误：{type(exc).__name__}: {exc}", "error")
                self.log(traceback.format_exc(limit=3), "debug")
                outcome = {"ok": False, "reason": "error", "message": str(exc)}
            finally:
                with self._lock:
                    self._ended_at = time.time()
                    self._result = outcome
                    if self._state not in ("cancelled", "error"):
                        reason = str(outcome.get("reason") or "")
                        self._state = (
                            "done" if outcome.get("ok")
                            else "cancelled" if reason == "cancelled"
                            else "failed"
                        )
                    self._controller = None
                self.emit({"type": "finished", "state": self._state, "result": outcome})

        thread = threading.Thread(target=runner, name=f"bili-{kind}", daemon=True)
        with self._lock:
            self._thread = thread
        thread.start()
        return True, "任务已启动"

    def attach(self, controller: Any) -> None:
        with self._lock:
            self._controller = controller

    def control(self, action: str) -> Tuple[bool, str]:
        with self._lock:
            controller = self._controller
            busy = self.busy
        if not busy:
            return False, "当前没有在跑的任务"
        if action == "stop":
            if controller is not None and hasattr(controller, "stop"):
                controller.stop()
            self._state = "cancelled"
            self.log("收到停止指令，正在收尾…", "warn")
            return True, "已请求停止"
        if action in ("pause", "resume"):
            if controller is None or not hasattr(controller, "pause"):
                return False, "这个任务不支持暂停"
            if action == "pause":
                controller.pause()
                self._state = "paused"
                return True, "已暂停"
            controller.resume()
            self._state = "running"
            return True, "已继续"
        return False, f"不认识的操作：{action}"


HUB = TaskHub()
_log_lock = threading.Lock()


def session_log(text: str) -> None:
    """把关键动作记到 logs 目录，方便事后对账。"""
    try:
        with _log_lock:
            path = log_dir() / f"{datetime.now():%Y-%m-%d}.log"
            with path.open("a", encoding="utf-8") as fh:
                fh.write(f"[{datetime.now():%H:%M:%S}] {text}\n")
    except OSError:
        pass


# ==========================================================================
# 业务处理
# ==========================================================================
def friendly_error(exc: Exception) -> str:
    if isinstance(exc, NotLoggedInError):
        return "登录态失效了，重新扫码登录一下吧"
    if isinstance(exc, RiskControlError):
        return f"被 B 站风控拦住了：{exc.message}。歇 30 分钟再试，别硬刚"
    if isinstance(exc, BiliError):
        code = exc.code
        table = {
            -400: "参数不太对，检查一下收藏夹链接",
            -403: "没有权限访问这个收藏夹（可能是私密的）",
            -404: "找不到这个收藏夹，ID 是不是敲错了",
            11010: "这个收藏夹不存在，或者已经被删掉了",
        }
        if code in table:
            return table[code]
        return f"接口返回错误：[{code}] {exc.message}"
    if isinstance(exc, requests.RequestException):
        return f"网络不太顺畅：{type(exc).__name__}，检查一下代理或者稍后再试"
    return f"{type(exc).__name__}: {exc}"


def require_login() -> Optional[str]:
    """写操作前确认登录态，返回错误信息或 None。"""
    CTX.ensure_loaded()
    if not CTX.client.has_session:
        return "还没登录呢，先扫码或者贴 Cookie 登录一下"
    if not CTX.client.csrf:
        return "登录信息不完整（缺 bili_jct），建议重新登录一次"
    return None


def need_login_payload() -> Dict[str, Any]:
    return {"ok": False, "reason": "auth", "error": "还没登录呢，先扫码或者贴 Cookie 登录一下"}


# ---------------- 登录 ----------------
def api_account(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    CTX.ensure_loaded()
    if not CTX.client.has_session:
        return {"ok": True, "is_login": False}
    try:
        account = CTX.client.my_account()
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "is_login": False, "warning": friendly_error(exc)}
    if account.get("is_login"):
        CTX.persist()
    return {"ok": True, **account}


def qr_svg(text: str, border: int = 3) -> str:
    """
    把文本渲染成二维码 SVG（本地生成，不外传）。

    用了一手行程合并：同一行连续的黑块合成一条路径，49x49 的矩阵
    SVG 也就几 KB，比逐格画 rect 小得多。
    """
    from .vendor import qrcodegen

    qr = qrcodegen.QrCode.encode_text(text, qrcodegen.QrCode.Ecc.MEDIUM)
    count = qr.get_size()
    size = count + border * 2
    segments: List[str] = []
    for y in range(count):
        x = 0
        while x < count:
            if not qr.get_module(x, y):
                x += 1
                continue
            start = x
            while x < count and qr.get_module(x, y):
                x += 1
            segments.append(f"M{start + border} {y + border}h{x - start}v1h-{x - start}z")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        f'shape-rendering="crispEdges" role="img" aria-label="登录二维码">'
        f'<rect width="{size}" height="{size}" fill="#ffffff"/>'
        f'<path d="{"".join(segments)}" fill="#000000"/>'
        f"</svg>"
    )


def api_login_qr(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    CTX.ensure_loaded()
    CTX.client.bootstrap()
    data = CTX.client.qr_generate()
    url = str(data.get("url") or "")
    if not url:
        return {"ok": False, "error": "拿二维码失败了，网络或者风控的问题，稍后再试"}
    try:
        svg = qr_svg(url)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"二维码画不出来：{exc}"}
    return {"ok": True, "url": url, "key": data.get("qrcode_key"), "svg": svg}


def api_login_qr_poll(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    key = str(query.get("key") or body.get("key") or "").strip()
    if not key:
        return {"ok": False, "error": "缺少 qrcode_key"}
    CTX.ensure_loaded()
    data = CTX.client.qr_poll(key)
    code = int(data.get("code") or 0)

    if code == 0:
        # 扫码成功，Cookie 已经进 session 了，顺手固化到关键域上
        session = CTX.session
        for name in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"):
            value = session.cookies.get(name) or session.cookies.get(name, domain="passport.bilibili.com")
            if value:
                session.cookies.set(name, value, domain=".bilibili.com", path="/")
        if not CTX.client.has_session:
            return {"ok": True, "state": "pending", "hint": "登录信息还没同步过来，再等等"}
        CTX.persist()
        account = CTX.client.my_account()
        session_log(f"扫码登录成功：{account.get('uname')} (mid={account.get('mid')})")
        return {"ok": True, "state": "success", "account": account}

    if code == 86038:
        return {"ok": True, "state": "expired", "hint": "二维码过期了，点一下刷新"}
    if code == 86090:
        return {"ok": True, "state": "scanned", "hint": "扫到了！在手机上点一下确认"}
    if code == 86101:
        return {"ok": True, "state": "waiting", "hint": "还没扫呢"}
    return {"ok": True, "state": "unknown", "hint": data.get("message") or f"状态码 {code}"}


def api_login_cookie(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    raw = str(body.get("cookie") or "").strip()
    if not raw:
        return {"ok": False, "error": "Cookie 是空的呀"}
    CTX.ensure_loaded()
    ok, message = CTX.client.load_cookies(raw)
    if not ok:
        return {"ok": False, "error": message}
    try:
        account = CTX.client.my_account()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}
    if not account.get("is_login"):
        return {"ok": False, "error": "Cookie 塞进去了，但 B 站说没登录。是不是复制漏了，或者已经过期？"}
    CTX.persist()
    session_log(f"Cookie 登录成功：{account.get('uname')} (mid={account.get('mid')})")
    return {"ok": True, "account": account}


def api_logout(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    CTX.forget()
    session_log("已退出登录，本地登录信息已清除")
    return {"ok": True}


# ---------------- 收藏夹 ----------------
def _folder_brief(folder: Dict[str, Any]) -> Dict[str, Any]:
    upper = folder.get("upper") if isinstance(folder.get("upper"), dict) else {}
    return {
        "media_id": int(folder.get("id") or 0),
        "title": str(folder.get("title") or ""),
        "count": int(folder.get("media_count") or 0),
        "privacy": int(folder.get("attr") or 0),
        "intro": str(folder.get("intro") or ""),
        "upper": str(upper.get("name") or ""),
        "upper_mid": int(upper.get("mid") or 0) or int(folder.get("mid") or 0),
    }


def _up_brief(info: Dict[str, Any]) -> Dict[str, Any]:
    """把空间信息和搜索结果统一成前端要的形状。"""
    vip = info.get("vip") or {}
    official = info.get("official") or info.get("official_verify") or {}
    face = str(info.get("face") or info.get("upic") or "")
    if face.startswith("//"):
        face = "https:" + face
    fans = info.get("fans")
    if fans is None:
        fans = info.get("fans_count") or 0
    # 搜索结果的昵称带高亮标签，去掉
    name = re.sub(r"<[^>]+>", "", str(info.get("name") or info.get("uname") or ""))
    try:
        vip_on = bool(vip.get("status") == 1 or vip.get("vipStatus") == 1
                      or int(vip.get("vipType") or 0) > 0)
    except (TypeError, ValueError):
        vip_on = False
    return {
        "mid": int(info.get("mid") or 0),
        "name": name,
        "face": face,
        "sign": str(info.get("sign") or info.get("usign") or ""),
        "fans": int(fans or 0),
        "vip": vip_on,
        "official": str(official.get("title") or official.get("desc") or ""),
        "official_type": int(official.get("type") or 0),
    }


def api_up_search(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    找 UP 主：填数字就当 UID 直查，填别的就当昵称搜。
    返回统一格式，前端拿它画头像、粉丝量和 V 标。
    """
    raw = str(body.get("input") or query.get("input") or "").strip()
    if not raw:
        return {"ok": False, "error": "填个 UID 或者昵称吧"}
    CTX.ensure_loaded()
    CTX.client.bootstrap()
    try:
        if raw.isdigit():
            info = CTX.client.user_info(int(raw))
            if not info or not info.get("mid"):
                return {"ok": False, "error": "没找到这个 UID，确认一下？"}
            # 空间信息里没有粉丝数，单独补一次
            if not info.get("fans"):
                info["fans"] = CTX.client.user_fans(int(raw))
            return {"ok": True, "users": [_up_brief(info)]}
        users = CTX.client.search_user(raw)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}
    if not users:
        return {"ok": True, "users": [], "hint": "没搜到，试试直接填 UID（那串数字）"}
    return {"ok": True, "users": [_up_brief(x) for x in users[:12]]}


def api_up_folders(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """某个 UP 主公开的收藏夹列表。"""
    mid = int(body.get("mid") or query.get("mid") or 0)
    if not mid:
        return {"ok": False, "error": "缺少 mid"}
    CTX.ensure_loaded()
    CTX.client.bootstrap()
    try:
        folders = CTX.client.user_fav_folders(mid)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}
    out = []
    for f in folders:
        fid = int(f.get("id") or 0)
        if not fid:
            continue
        out.append({
            "media_id": fid,
            "title": str(f.get("title") or ""),
            "count": int(f.get("media_count") or 0),
            "privacy": 0,   # 这个接口本来就只返回公开的
        })
    out.sort(key=lambda x: x["count"], reverse=True)
    return {"ok": True, "folders": out}


def _strip_tags(text: Any) -> str:
    """搜索结果里的标题/昵称带 <em> 高亮标签，去掉。"""
    return re.sub(r"<[^>]+>", "", str(text or "")).strip()


def _duration_seconds(text: Any) -> int:
    """把 "12:34" / "1:02:03" 这种时长转成秒。"""
    parts = [p for p in str(text or "").split(":") if p != ""]
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return 0
    sec = 0
    for n in nums:
        sec = sec * 60 + n
    return sec


def api_video_search(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """按标题搜视频，给「添加视频」那个弹窗用。带翻页。"""
    kw = str(body.get("keyword") or query.get("keyword") or "").strip()
    if not kw:
        return {"ok": False, "error": "想搜点啥？"}
    try:
        page = max(1, min(50, int(body.get("page") or query.get("page") or 1)))
    except (TypeError, ValueError):
        page = 1
    CTX.ensure_loaded()
    CTX.client.bootstrap()
    try:
        with CTX.client.faster(0.5):
            rows = CTX.client.search_video(kw, page=page)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}
    out = []
    for r in rows[:20]:
        bvid = str(r.get("bvid") or "").strip()
        if not bvid:
            continue
        pic = str(r.get("pic") or "")
        if pic.startswith("//"):
            pic = "https:" + pic
        out.append({
            "key": bvid,
            "bvid": bvid,
            "avid": int(r.get("aid") or 0),
            "type": 2,
            "title": _strip_tags(r.get("title")),
            "upper": _strip_tags(r.get("author")),
            "cover": pic,
            "play": int(r.get("play") or 0),
            "danmaku": int(r.get("video_review") or 0),
            "collect": int(r.get("favorites") or 0),
            "duration": _duration_seconds(r.get("duration")),
            "pubtime": int(r.get("pubdate") or 0),
            "invalid": False,
        })
    return {"ok": True, "videos": out, "page": page, "has_more": len(out) >= 20}


def api_video_info(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """视频的 UP 主信息（详情面板显示头像用）。"""
    bvid = str(body.get("bvid") or query.get("bvid") or "").strip()
    if not bvid:
        return {"ok": False, "error": "缺少 bvid"}
    CTX.ensure_loaded()
    CTX.client.bootstrap()
    try:
        owner = CTX.client.video_owner(bvid)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}
    face = str(owner.get("face") or "")
    if face.startswith("//"):
        face = "https:" + face
    return {
        "ok": True,
        "owner": {
            "mid": int(owner.get("mid") or 0),
            "name": str(owner.get("name") or ""),
            "face": face,
        },
    }


def api_video_tags(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """某个视频在 B 站上的标签（详情面板、以及「按站内标签自动打标签」用）。"""
    bvid = str(body.get("bvid") or query.get("bvid") or "").strip()
    if not bvid:
        return {"ok": False, "error": "缺少 bvid"}
    CTX.ensure_loaded()
    CTX.client.bootstrap()
    # 自动打标签会连着读整个收藏夹，一次几百条，这里把限速调松一点；
    # 只读接口，不写任何东西，松一点也不会伤到账号。
    # 用 faster() 而不是直接改 delay：并发的请求不会互相把值写回去。
    try:
        with CTX.client.faster(0.3):
            tags = CTX.client.video_tags(bvid)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}
    return {"ok": True, "tags": [t for t in tags if t][:24]}


def api_folder_resolve(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """解析用户粘贴的收藏夹链接/ID，返回基本信息 + 前几条预览。"""
    raw = str(body.get("input") or "").strip()
    media_id = parse_media_id(raw)
    if not media_id:
        return {"ok": False, "error": "没看懂这个输入，贴收藏夹链接或者那一串数字 ID 都行"}

    CTX.ensure_loaded()
    CTX.client.bootstrap()
    try:
        info = CTX.client.fav_folder_info(media_id)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}

    if not info:
        return {
            "ok": False,
            "error": "这个收藏夹读不到。可能是 ID 不对、收藏夹被删了，或者是私密的",
        }

    brief = _folder_brief(info)
    if brief["privacy"] not in (0, 6, 22):  # 非公开的收藏夹读不到内容（除非是自己账号）
        pass

    preview: List[Dict[str, Any]] = []
    try:
        data = CTX.client.fav_resource_list(media_id, pn=1, ps=10, order="mtime")
        preview = normalize_items(data.get("medias") or [])
    except Exception:  # noqa: BLE001 - 预览失败不影响主流程
        preview = []

    CTX.client.log(f"解析收藏夹 {media_id}：{brief['title']}（{brief['count']} 条）")
    return {"ok": True, "folder": brief, "preview": preview}


def api_my_folders(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    err = require_login()
    if err:
        return need_login_payload()
    try:
        account = CTX.client.my_account()
        if not account.get("is_login"):
            return need_login_payload()
        folders = CTX.client.my_fav_folders(int(account["mid"]))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}

    items = [_folder_brief(f) for f in folders]
    items.sort(key=lambda x: x["media_id"], reverse=True)
    return {"ok": True, "folders": items, "account": account}


def api_folder_create(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    err = require_login()
    if err:
        return need_login_payload()
    title = str(body.get("title") or "").strip()
    if not title:
        return {"ok": False, "error": "得给新收藏夹起个名字"}
    if len(title) > 40:
        return {"ok": False, "error": "标题太长了，B 站最多 40 个字"}
    privacy = 1 if int(body.get("privacy") or 0) else 0
    try:
        data = CTX.client.create_fav_folder(title, privacy)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}
    CTX.client.log(f"新建收藏夹：{title}")
    return {"ok": True, "folder": _folder_brief(data if isinstance(data, dict) else {})}


# ---------------- 收藏夹内容缓存 ----------------
# 每次读完一个收藏夹就存一份。打开时先铺缓存，后台再刷新成最新的。
# 存 data/cache/ 下，删掉整个目录也只是"第一次慢一点"，不会丢数据。
_CACHE_LOCK = threading.Lock()
_SEARCH_INDEX = {}  # media_id -> (path/mtime/size, fetched_at, normalized rows)


def _folder_cache_file(media_id: int) -> Path:
    return cache_dir() / f"items-{int(media_id)}.json"


def read_folder_cache(media_id: int) -> Optional[Dict[str, Any]]:
    """读缓存。读不到 / 坏了 / 空的都算没有。"""
    path = _folder_cache_file(media_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return None
    return data


def write_folder_cache(media_id: int, folder: Dict[str, Any],
                       items: List[Dict[str, Any]]) -> None:
    """写缓存。写不进去也不该影响这次读取，所以吞掉异常。"""
    try:
        with _CACHE_LOCK:
            path = _folder_cache_file(media_id)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps({
                "media_id": int(media_id),
                "fetched_at": int(time.time()),
                "folder": folder or {},
                "items": items,
            }, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
            _SEARCH_INDEX.pop(int(media_id), None)
    except OSError:
        pass


def clear_folder_cache(media_id: int) -> None:
    """顺序改了之后缓存就不对了，删掉。"""
    try:
        with _CACHE_LOCK:
            path = _folder_cache_file(media_id)
            if path.exists():
                path.unlink()
            _SEARCH_INDEX.pop(int(media_id), None)
    except OSError:
        pass


def api_folder_cache(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    上次读到的收藏夹内容。

    可能不是最新的 —— 前端拿它先把界面填上，同时后台照常读最新的，
    读到之后整个替换。响应里带 age（多少秒前读的），界面据此标一句。
    """
    media_id = int(body.get("media_id") or query.get("media_id") or 0)
    if not media_id:
        return {"ok": False, "error": "缺少 media_id"}
    data = read_folder_cache(media_id)
    if not data:
        return {"ok": True, "hit": False}
    fetched = int(data.get("fetched_at") or 0)
    return {
        "ok": True,
        "hit": True,
        "folder": data.get("folder") or {},
        "items": data.get("items") or [],
        "fetched_at": fetched,
        "age": max(0, int(time.time()) - fetched) if fetched else 0,
    }


def api_folder_search_cache(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """只搜索本机已完整读取过的收藏夹，不初始化账号、不访问远程接口。"""
    keyword = str(body.get("keyword") or "").strip().casefold()
    ids = body.get("media_ids")
    if not keyword or len(keyword) > 200 or not isinstance(ids, list) or len(ids) > 5000:
        return {"ok": False, "error": "搜索关键词或收藏夹范围不正确"}
    try:
        ids = list(dict.fromkeys(int(i) for i in ids))
        if any(i <= 0 for i in ids):
            raise ValueError()
    except (ValueError, TypeError, OverflowError):
        return {"ok": False, "error": "收藏夹 ID 不正确"}
    folders, missing = [], []
    for mid in ids:
        with _CACHE_LOCK:
            try:
                path = _folder_cache_file(mid)
                stat = path.stat()
                signature = (str(path), stat.st_mtime_ns, stat.st_size)
                cached = _SEARCH_INDEX.get(mid)
                if cached is None or cached[0] != signature:
                    data = read_folder_cache(mid)
                    if data is None:
                        raise ValueError()
                    rows = [(str(it.get("title") or "").casefold() + "\n"
                             + str(it.get("upper") or "").casefold(), it)
                            for it in data["items"] if isinstance(it, dict)]
                    cached = (signature, int(data.get("fetched_at") or 0), rows)
                    # 控制常驻索引占用；原始文件仍保留。
                    while _SEARCH_INDEX and (len(_SEARCH_INDEX) >= 128
                                             or sum(len(v[2]) for v in _SEARCH_INDEX.values()) + len(rows) > 100000):
                        _SEARCH_INDEX.pop(next(iter(_SEARCH_INDEX)))
                    _SEARCH_INDEX[mid] = cached
            except (OSError, ValueError, TypeError):
                _SEARCH_INDEX.pop(mid, None)
                missing.append(mid)
                continue
            matches = [it for text, it in cached[2] if keyword in text]
            folders.append({"media_id": mid, "fetched_at": cached[1],
                            "count": len(matches), "items": matches[:50]})
    return {"ok": True, "folders": folders, "missing": missing}


def api_folder_items(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    拉取某个收藏夹的全部条目（整理顺序用）。

    返回的 items 顺序就是服务端给的顺序，前端会把它原样当作"当前顺序"。
    """
    media_id = int(body.get("media_id") or query.get("media_id") or 0)
    if not media_id:
        return {"ok": False, "error": "缺少 media_id"}
    order = str(body.get("order") or "mtime")
    keyword = str(body.get("keyword") or query.get("keyword") or "").strip()
    preview = bool(body.get("preview") or query.get("preview"))
    CTX.ensure_loaded()
    CTX.client.bootstrap()

    # ---- 探路：只拿第一页，让界面**立刻有东西显示** ----
    # 大收藏夹要翻几十页、等十几秒，让用户对着空屏干等太难受。
    # 先给前 20 条垫着，完整列表在后台继续读，读到之后整个替换掉。
    # 所以这一步只是"先看看"，前端拿到它期间会锁住编辑。
    if preview:
        try:
            with CTX.client.faster(0.25, jitter=0.05):
                info = CTX.client.fav_folder_info(media_id)
                data = CTX.client.fav_resource_list(media_id, pn=1, ps=20, order=order)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": friendly_error(exc)}

        medias = [x for x in (data.get("medias") or []) if isinstance(x, dict)]
        return {
            "ok": True,
            "folder": _folder_brief(info or {}),
            "items": normalize_items(medias),
            "preview": True,
            "has_more": bool(data.get("has_more")),
        }

    # ---- 收藏夹内搜索：只读小请求，别按搬运的节奏慢慢等 ----
    # 抽屉里「按视频找收藏夹」就是逐个收藏夹走这条路，所以限速临时调松一点。
    if keyword:
        try:
            with CTX.client.faster(0.35):
                info = CTX.client.fav_folder_info(media_id)
                data = CTX.client.fav_resource_list(
                    media_id, pn=1, ps=20, order=order, keyword=keyword
                )
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": friendly_error(exc)}

        medias = [x for x in (data.get("medias") or []) if isinstance(x, dict)]
        return {
            "ok": True,
            "folder": _folder_brief(info or {}),
            "items": normalize_items(medias),
            "has_more": bool(data.get("has_more")),
            "keyword": keyword,
        }

    pages: List[int] = []

    def on_page(page: int, count: int) -> None:
        pages.append(page)

    try:
        info = CTX.client.fav_folder_info(media_id)
        # 这是**只读**的逐页读取，不是写操作，没必要按 1.5 秒/页那种保守节奏来。
        # 实测：B 站这个接口每页最多 20 条，945 条的收藏夹要翻 48 页 ——
        # 按默认限速得等一分半，调到 0.25 秒大约十几秒就完了。
        # 敢调的理由：只读、不改数据，而且是用户点开收藏夹才触发的一次性读取，
        # 不是高频轮询。
        with CTX.client.faster(0.25, jitter=0.05):
            raw_items = CTX.client.fav_resource_all(media_id, order=order, on_page=on_page)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}

    if not raw_items and not info:
        return {"ok": False, "error": "这个收藏夹读不到内容，确认一下 ID 和可见性"}

    items = normalize_items(raw_items)
    folder = _folder_brief(info or {})
    # 存一份，下次切回来就不用再等这 8 秒
    write_folder_cache(media_id, folder, items)
    return {
        "ok": True,
        "folder": folder,
        "items": items,
        "pages": len(pages),
    }


# ---------------- 收藏夹：编辑 / 清理 / 搬家 ----------------
def _my_folder_or_error(media_id: int) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """确认这个收藏夹确实是自己账号下的，返回 (简介, None) 或 (None, 错误体)。"""
    try:
        account = CTX.client.my_account(max_age=60)
        if not account.get("is_login"):
            return None, need_login_payload()
        info = CTX.client.fav_folder_info(int(media_id))
    except Exception as exc:  # noqa: BLE001
        return None, {"ok": False, "error": friendly_error(exc)}
    if not info:
        return None, {"ok": False, "error": "读不到这个收藏夹"}
    if int(info.get("mid") or 0) != int(account["mid"]):
        return None, {"ok": False, "error": "只能动自己账号下的收藏夹"}
    return _folder_brief(info), None


def api_folder_edit(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """改收藏夹的标题 / 简介 / 公开性。"""
    err = require_login()
    if err:
        return need_login_payload()
    media_id = int(body.get("media_id") or 0)
    if not media_id:
        return {"ok": False, "error": "缺少 media_id"}
    title = str(body.get("title") or "").strip()
    if not title:
        return {"ok": False, "error": "标题不能空着"}
    if len(title) > 40:
        return {"ok": False, "error": "标题最多 40 个字"}
    brief, bad = _my_folder_or_error(media_id)
    if bad:
        return bad
    intro = str(body.get("intro") or "").strip()[:200]
    privacy = 1 if int(body.get("privacy") or 0) else 0
    try:
        CTX.client.edit_fav_folder(media_id, title, intro, privacy)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}
    CTX.client.log(f"改了收藏夹信息：{title}（{media_id}）")
    session_log(f"编辑收藏夹 {media_id}：{title}")
    folder = dict(brief or {})
    folder.update({"title": title, "intro": intro, "privacy": privacy})
    # 改名不改变视频内容，也不能把旧视频缓存的时间冒充成刚刚刷新。
    try:
        with _CACHE_LOCK:
            cached = read_folder_cache(media_id)
            if cached:
                cached["folder"] = {**(cached.get("folder") or {}), **folder}
                path = _folder_cache_file(media_id)
                tmp = path.with_suffix(".tmp")
                tmp.write_text(json.dumps(cached, ensure_ascii=False), encoding="utf-8")
                tmp.replace(path)
                _SEARCH_INDEX.pop(media_id, None)
    except OSError:
        pass
    return {"ok": True, "folder": folder}


def _open_default_browser(url: str) -> None:
    """Windows 直接交给系统 URL 关联；其他平台检查启动是否确实成功。"""
    if os.name == "nt":
        os.startfile(url)
    elif not webbrowser.open(url):
        raise RuntimeError("系统没有成功启动默认浏览器")


def api_open_browser(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    用系统默认浏览器打开界面。

    给顶栏那个「在浏览器里打开」按钮用的。走后台而不是前端 window.open()：
    在原生窗口 / 浏览器应用模式里，前端那一下不一定真能开出系统浏览器。

    只允许本机地址 —— 不然这就成了一个"随便打开任意网页"的口子。
    """
    url = str(body.get("url") or query.get("url") or "").strip()
    if not url:
        return {"ok": False, "error": "缺少 url"}
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return {"ok": False, "error": "本机链接无效"}
    if (len(url) > 2000 or parsed.scheme != "http" or parsed.username or parsed.password
            or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or any(ord(c) < 32 for c in url)):
        return {"ok": False, "error": "只允许打开本机地址"}

    try:
        _open_default_browser(url)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"打不开浏览器：{exc}"}
    return {"ok": True}


def api_open_external(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    用**系统默认浏览器**打开一个 B 站页面。

    给视频详情里的「去 B 站看」和右键菜单里的「打开」用的。

    为什么不跟前端 window.open：程序平时跑在 Edge WebView2 / Edge 应用模式里，
    前端那一下开出来的还是 Edge 的小窗（用户报的就是"点去 B 站看跳出的是 EDGE"），
    而他想要的是系统认的那个默认浏览器 —— 只有后台的 webbrowser.open 才做得到。

    为什么不直接复用 /api/open-browser：那个的白名单是"只允许本机地址"，
    这个正好相反、只允许 B 站域名。两个口子分开管，谁也别顺手被拿去开别的站。
    """
    url = str(body.get("url") or query.get("url") or "").strip()
    if not url:
        return {"ok": False, "error": "缺少 url"}
    if len(url) > 2000:
        return {"ok": False, "error": "链接太长了"}

    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return {"ok": False, "error": "B 站链接无效"}
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https"):
        return {"ok": False, "error": "只支持 http / https 链接"}
    allowed = (
        host == "bilibili.com" or host.endswith(".bilibili.com")
        or host == "b23.tv" or host.endswith(".b23.tv")
    )
    if not allowed or parsed.username or parsed.password or any(ord(c) < 32 for c in url):
        return {"ok": False, "error": "只允许打开 B 站的链接"}

    try:
        _open_default_browser(url)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"打不开浏览器：{exc}"}
    session_log(f"用默认浏览器打开：{url}")
    return {"ok": True}


def api_folder_add_items(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    把一批视频加进某个收藏夹。

    给"把卡片拖到左侧收藏夹栏"用的。走 B 站的批量收藏接口，一次能加多张；
    批量不可用就退回逐条（有些账号 / 有些内容类型批量会被拒）。

    **同步执行**，不挂任务中心 —— 一次也就几十条，前端等结果比轮询省事。
    加完就生效了，不需要再点「提交改动」（提交那套管的是**顺序**）。
    """
    err = require_login()
    if err:
        return need_login_payload()

    media_id = int(body.get("media_id") or 0)
    if not media_id:
        return {"ok": False, "error": "缺少 media_id"}

    items = body.get("items") or []
    if not isinstance(items, list) or not items:
        return {"ok": False, "error": "没有要添加的内容"}

    brief, bad = _my_folder_or_error(media_id)
    if bad:
        return bad
    folder = brief or {}

    res: List[Tuple[int, int]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            avid = int(it.get("avid") or 0)
        except (TypeError, ValueError):
            continue
        if avid:
            try:
                ctype = int(it.get("type") or 2)
            except (TypeError, ValueError):
                ctype = 2
            res.append((avid, ctype))

    if not res:
        return {"ok": False, "error": "这些条目拿不到 avid，加不了"}

    CTX.ensure_loaded()
    CTX.client.bootstrap()

    title = folder.get("title") or "目标收藏夹"
    added = 0
    failed = 0
    successful = []
    # 只读那种节奏不适用：这是写操作，但也不是"逐条搬运"，
    # 一次几十个而已，稍微放开一点就够，别把 B 站惹毛。
    with CTX.client.faster(0.4, jitter=0.1):
        for i in range(0, len(res), 20):
            chunk = res[i:i + 20]
            try:
                CTX.client.fav_batch_deal(chunk, add_media_ids=[media_id])
                added += len(chunk)
                successful.extend(chunk)
                clear_folder_cache(media_id)
                continue
            except (NotLoggedInError, Cancelled):
                raise
            except RiskControlError:
                raise
            except BiliError:
                pass
            # 批量不行，逐条来
            for rid, ctype in chunk:
                try:
                    CTX.client.fav_deal(rid, add_media_ids=[media_id], content_type=ctype)
                    added += 1
                    successful.append((rid, ctype))
                    clear_folder_cache(media_id)
                except RiskControlError:
                    raise
                except BiliError:
                    failed += 1

    # ---- 剪切：加完之后把源收藏夹里那份删掉 ----
    # 只有"加成功了"的才删。加失败还删，那就等于把用户的视频弄丢了。
    removed = 0
    removed_items = []
    remove_from = int(body.get("remove_from") or 0)
    if remove_from and remove_from != media_id and added:
        src_brief, src_bad = _my_folder_or_error(remove_from)
        if src_bad:
            CTX.client.log("剪切：源收藏夹读不到，跳过了删除这一步", "warn")
        else:
            src_title = (src_brief or {}).get("title") or "源收藏夹"
            with CTX.client.faster(0.4, jitter=0.1):
                for i in range(0, len(successful), 20):
                    chunk = successful[i:i + 20]
                    try:
                        CTX.client.fav_batch_deal(chunk, del_media_ids=[remove_from])
                        removed += len(chunk)
                        removed_items.extend(chunk)
                        clear_folder_cache(remove_from)
                        continue
                    except (NotLoggedInError, Cancelled, RiskControlError):
                        raise
                    except BiliError:
                        pass
                    for rid, ctype in chunk:
                        try:
                            CTX.client.fav_deal(rid, del_media_ids=[remove_from], content_type=ctype)
                            removed += 1
                            removed_items.append((rid, ctype))
                            clear_folder_cache(remove_from)
                        except RiskControlError:
                            raise
                        except BiliError:
                            pass
            CTX.client.log(f"剪切：从「{src_title}」移出 {removed} 条")

    CTX.client.log(f"往「{title}」添加 {added} 条" + (f"，失败 {failed}" if failed else ""))
    return {"ok": True, "added": added, "failed": failed, "removed": removed,
            "removed_items": removed_items, "folder": folder}


def api_folder_clean(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    一键清掉收藏夹里所有已失效的内容。

    走的是 B 站自己的清理接口，比"先标记失效项、再逐条提交删除"快得多 ——
    不用把几百个删除请求挨个发一遍。
    """
    err = require_login()
    if err:
        return need_login_payload()
    media_id = int(body.get("media_id") or 0)
    if not media_id:
        return {"ok": False, "error": "缺少 media_id"}
    brief, bad = _my_folder_or_error(media_id)
    if bad:
        return bad
    folder = brief or {}

    def work(hub: TaskHub) -> Dict[str, Any]:
        hub.log(f"请 B 站清掉「{folder.get('title', '')}」里的失效内容…")
        hub.update_extra(folder=folder)
        clear_folder_cache(media_id)
        CTX.client.fav_clean(media_id)
        hub.log("清理指令已发出，B 站会自己处理，过一会儿刷新看看", "ok")
        return {"ok": True, "reason": "finished", "message": "失效内容已清理"}

    ok, message = HUB.start("clean", f"清理失效 · {folder.get('title', '')}", work)
    if not ok:
        return {"ok": False, "error": message}
    session_log(f"清理失效内容：{media_id}")
    return {"ok": True, "message": message, "folder": folder}


def _collect_resources(hub: TaskHub, media_id: int) -> List[Tuple[int, int]]:
    """把某个收藏夹里的条目列成 (avid, type) 清单。"""
    out: List[Tuple[int, int]] = []
    seen: set = set()
    page = 1
    while page <= 2000:
        data = CTX.client.fav_resource_list(media_id, pn=page, ps=20, order="mtime")
        medias = [m for m in (data.get("medias") or []) if isinstance(m, dict)]
        for m in medias:
            aid = int(m.get("id") or 0)
            ctype = int(m.get("type") or 2)
            if not aid or (aid, ctype) in seen:
                continue
            seen.add((aid, ctype))
            out.append((aid, ctype))
        if len(out) and len(out) % 200 < 20:
            hub.log(f"已经列出 {len(out)} 条…")
        if not medias or not data.get("has_more"):
            break
        page += 1
    return out


def _folder_transfer(body: Dict[str, Any], mode: str) -> Dict[str, Any]:
    """
    mode="move" → 把自己 A 收藏夹的内容**搬**到 B（A 里就没有了）
    mode="copy" → 复制一份过去（A 里还留着），也就是"合并两个收藏夹"

    两者都走 B 站的服务端批量接口，一次请求搞定一批 ——
    和「搬运」（逐条 1.5 秒）完全不是一个量级。
    """
    err = require_login()
    if err:
        return need_login_payload()
    src = int(body.get("src_media_id") or 0)
    tar = int(body.get("tar_media_id") or 0)
    if not src or not tar:
        return {"ok": False, "error": "源和目标都得选好"}
    if src == tar:
        return {"ok": False, "error": "源和目标撞在同一个收藏夹上了"}

    src_brief, bad = _my_folder_or_error(src)
    if bad:
        return bad
    tar_brief, bad = _my_folder_or_error(tar)
    if bad:
        return bad
    try:
        account = CTX.client.my_account()
        my_mid = int(account["mid"])
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}

    verb = "整个挪到" if mode == "move" else "复制一份到"

    def work(hub: TaskHub) -> Dict[str, Any]:
        hub.log(
            f"把「{src_brief.get('title', '')}」里的内容{verb}"
            f"「{tar_brief.get('title', '')}」—— 走服务端批量接口，不用一条条来"
        )
        hub.update_extra(source=src_brief, target=tar_brief)
        resources = _collect_resources(hub, src)
        if not resources:
            return {"ok": True, "reason": "finished", "message": "源收藏夹里没东西可搬"}

        total = len(resources)
        hub.log(f"一共 {total} 条，分批交给 B 站…")
        chunk = 300
        done = 0
        for start in range(0, total, chunk):
            part = resources[start:start + chunk]
            clear_folder_cache(tar)
            if mode == "move":
                clear_folder_cache(src)
                CTX.client.fav_move(src, tar, my_mid, part)
            else:
                CTX.client.fav_batch_copy(src, tar, my_mid, part)
            done += len(part)
            hub.update_extra(stats={"total": total, "done": done, "remaining": total - done})
            hub.log(f"已提交 {done}/{total} 条")
        return {
            "ok": True,
            "reason": "finished",
            "message": f"{'搬' if mode == 'move' else '复制'}过去 {total} 条",
        }

    label = f"{'搬家' if mode == 'move' else '合并'} · {src_brief.get('title', '')} → {tar_brief.get('title', '')}"
    ok, message = HUB.start(mode, label, work)
    if not ok:
        return {"ok": False, "error": message}
    session_log(f"{mode} 收藏夹：{src} → {tar}")
    return {"ok": True, "message": message, "source": src_brief, "target": tar_brief}


def api_folder_move(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """把自己账号下 A 收藏夹的内容整体搬到 B。"""
    return _folder_transfer(body, "move")


def api_folder_merge(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """把自己账号下 A 收藏夹的内容复制到 B（合并两个收藏夹）。"""
    return _folder_transfer(body, "copy")


# ---------------- 整理草稿（防丢） ----------------
def _draft_path(media_id: int) -> Path:
    return draft_dir() / f"fav{int(media_id)}.json"


def api_draft_save(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """把整理页还没提交的改动存下来 —— 免得误关窗口半小时白拖。"""
    media_id = int(body.get("media_id") or 0)
    if not media_id:
        return {"ok": False, "error": "缺少 media_id"}
    draft = body.get("draft")
    if not isinstance(draft, dict):
        return {"ok": False, "error": "草稿格式不对"}
    payload = {
        "media_id": media_id,
        "saved_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "title": str(body.get("title") or "")[:80],
        "draft": draft,
    }
    path = _draft_path(media_id)
    try:
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        return {"ok": False, "error": f"草稿存不下来：{exc}"}
    return {"ok": True, "saved_at": payload["saved_at"]}


def api_draft_load(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    media_id = int(body.get("media_id") or query.get("media_id") or 0)
    if not media_id:
        return {"ok": False, "error": "缺少 media_id"}
    path = _draft_path(media_id)
    if not path.exists():
        return {"ok": True, "draft": None}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"ok": True, "draft": None}
    return {"ok": True, "draft": payload if isinstance(payload, dict) else None}


def api_draft_clear(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    media_id = int(body.get("media_id") or 0)
    if not media_id:
        return {"ok": False, "error": "缺少 media_id"}
    try:
        _draft_path(media_id).unlink()
    except OSError:
        pass
    return {"ok": True}


# ---------------- 导出收藏夹清单 ----------------
def api_folder_export(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    把界面上这份清单导出成 CSV，落在 data/exports/ 下面。

    导的是**你看到的那一份**（含还没提交的改动），不是重新去线上一遍 ——
    所以可以拿它"把整理好的结果先留个底"，或者贴给别人看。
    """
    items = body.get("items")
    if not isinstance(items, list) or not items:
        return {"ok": False, "error": "现在没有可导出的内容"}
    if len(items) > 20000:
        return {"ok": False, "error": "条目太多了，一次最多两万条"}
    title = str(body.get("title") or "收藏夹").strip()[:60] or "收藏夹"
    try:
        out_dir = export_dir()
    except OSError as exc:
        return {"ok": False, "error": f"建不了导出目录：{exc}"}

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe = re.sub(r'[\\/:*?"<>|\s]+', "_", title)[:40] or "收藏夹"
    path = out_dir / f"{safe}-{stamp}.csv"

    def _when(value: Any) -> str:
        try:
            n = int(value or 0)
        except (TypeError, ValueError):
            return ""
        if n <= 0:
            return ""
        try:
            return datetime.fromtimestamp(n).strftime("%Y-%m-%d %H:%M")
        except (OSError, OverflowError, ValueError):
            return ""

    def _dur(value: Any) -> str:
        try:
            n = max(0, int(value or 0))
        except (TypeError, ValueError):
            return ""
        h, rem = divmod(n, 3600)
        m, s = divmod(rem, 60)
        return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"

    def _idx(row: Dict[str, Any], done: int) -> int:
        """序号：调用方给了就用，没给（或者给了个非正数）就按写出顺序自己数。

        以前是直接 int(row.get("idx") or 0)，前端哪天漏了这个键，整列就全变成 0 ——
        序号这种事没有理由依赖调用方。
        """
        try:
            n = int(row.get("idx") or 0)
        except (TypeError, ValueError):
            n = 0
        return n if n > 0 else done + 1

    count = 0
    try:
        # utf-8-sig：Excel 双击打开中文 CSV 不会乱码
        with path.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(["序号", "标题", "UP 主", "时长", "播放量", "弹幕数",
                             "收藏时间", "链接", "标签", "状态"])
            for row in items:
                if not isinstance(row, dict):
                    continue
                bvid = str(row.get("bvid") or "").strip()
                try:
                    avid = int(row.get("avid") or 0)
                except (TypeError, ValueError):
                    avid = 0
                url = (f"https://www.bilibili.com/video/{bvid}" if bvid
                       else (f"https://www.bilibili.com/video/av{avid}" if avid else ""))
                marks = []
                if row.get("invalid"):
                    marks.append("已失效")
                if row.get("deleted"):
                    marks.append("待删除")
                if row.get("added"):
                    marks.append("新追加")
                writer.writerow([
                    _idx(row, count),
                    str(row.get("title") or ""),
                    str(row.get("upper") or ""),
                    _dur(row.get("duration")),
                    int(row.get("play") or 0),
                    int(row.get("danmaku") or 0),
                    _when(row.get("fav_time")),
                    url,
                    # 标签是你自己贴的，导出必须带上 —— 不然"导出→改→导入"这条
                    # 路走一趟，标签就全丢了。用顿号连起来，跟状态列一个风格。
                    "、".join(str(x) for x in (row.get("tags") or []) if str(x).strip()),
                    "、".join(marks),
                ])
                count += 1
    except OSError as exc:
        return {"ok": False, "error": f"写不出来：{exc}"}

    session_log(f"导出收藏夹清单：{path.name}（{count} 条）")
    return {"ok": True, "path": str(path), "name": path.name, "count": count}


# ---------------- 界面偏好（收藏夹顺序 / 自定义快捷键 / 标签回收站…） ----------------
# 存 data/config/prefs.json，而不是浏览器存储 —— 换台电脑把 data/ 拷走还能带着。
#
# `ui` 里放的是"以前只存在浏览器里"的那批：标签、视频标签、回收站、主题、
# 每页数量、抽屉宽度、上次打开的收藏夹。统一搬过来，用户就不用担心
# 清一次浏览器数据把东西全清没了。
_PREFS_LOCK = threading.Lock()
_PREFS_KEYS = ("folder_order", "shortcuts", "misc", "ui")
_PREFS_MAX = 4 * 1024 * 1024


def _load_prefs() -> Dict[str, Any]:
    path = prefs_file()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def api_prefs_get(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    with _PREFS_LOCK:
        return {"ok": True, "prefs": _load_prefs()}


def api_prefs_set(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """只更新传进来的那几个键，其它保持不变。"""
    patch = body.get("prefs")
    if not isinstance(patch, dict) or not patch:
        return {"ok": False, "error": "没有要存的设置"}
    unknown = [k for k in patch if k not in _PREFS_KEYS]
    if unknown:
        return {"ok": False, "error": f"不认识的设置项：{', '.join(unknown[:3])}"}
    try:
        size = len(json.dumps(patch, ensure_ascii=False))
    except (TypeError, ValueError):
        return {"ok": False, "error": "设置里塞了存不了的东西"}
    if size > _PREFS_MAX:
        return {"ok": False, "error": "设置太大了"}
    with _PREFS_LOCK:
        data = _load_prefs()
        data.update(patch)
        path = prefs_file()
        try:
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:
            return {"ok": False, "error": f"设置存不下来：{exc}"}
    return {"ok": True, "prefs": data}


def api_prefs_ui_patch(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """UI 子键增量合并；原配置文件格式及旧接口保持兼容。"""
    patch = body.get("ui")
    if not isinstance(patch, dict) or not patch or len(patch) > 5000:
        return {"ok": False, "error": "没有可保存的设置"}
    if any(not isinstance(k, str) or not k or len(k) > 200
           or k in ("__proto__", "constructor", "prototype") for k in patch):
        return {"ok": False, "error": "设置项名称不正确"}
    try:
        if len(json.dumps(patch, ensure_ascii=False).encode("utf-8")) > _PREFS_MAX:
            return {"ok": False, "error": "设置太大了"}
    except (TypeError, ValueError):
        return {"ok": False, "error": "设置格式不正确"}
    with _PREFS_LOCK:
        data = _load_prefs()
        ui = data.get("ui")
        data["ui"] = {**(ui if isinstance(ui, dict) else {}), **patch}
        path = prefs_file()
        try:
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:
            return {"ok": False, "error": f"设置存不下来：{exc}"}
    return {"ok": True}


def api_folder_delete(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    删掉一个收藏夹。

    两种删法：
      · 直接删 —— 里面的内容跟着一起没
      · 先搬家再删 —— 把内容整体挪到另一个收藏夹，再删这个（默认推荐这个）

    顺带说明：B 站没有公开的"收藏夹之间排序"接口，所以收藏夹列表的顺序
    只能在本工具里本地排（存在 data/config/prefs.json）。
    """
    err = require_login()
    if err:
        return need_login_payload()
    media_id = int(body.get("media_id") or 0)
    if not media_id:
        return {"ok": False, "error": "缺少 media_id"}
    move_to = int(body.get("move_to") or 0)
    if move_to == media_id:
        return {"ok": False, "error": "要搬去的地方不能是它自己"}

    src, bad = _my_folder_or_error(media_id)
    if bad:
        return bad
    tar: Optional[Dict[str, Any]] = None
    if move_to:
        tar, bad = _my_folder_or_error(move_to)
        if bad:
            return bad
    try:
        account = CTX.client.my_account()
        my_mid = int(account["mid"])
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}

    src_title = str((src or {}).get("title") or "")

    def work(hub: TaskHub) -> Dict[str, Any]:
        moved = 0
        if move_to and tar:
            hub.log(f"先把「{src_title}」里的内容搬到「{tar.get('title', '')}」…")
            resources = _collect_resources(hub, media_id)
            total = len(resources)
            chunk = 300
            for start in range(0, total, chunk):
                part = resources[start:start + chunk]
                CTX.client.fav_move(media_id, move_to, my_mid, part)
                moved += len(part)
                hub.update_extra(stats={"total": total, "done": moved})
                hub.log(f"已搬 {moved}/{total} 条")
            hub.log(f"搬完了，一共 {moved} 条", "ok")
        hub.log(f"删掉收藏夹「{src_title}」…")
        CTX.client.delete_fav_folder([media_id])
        clear_folder_cache(media_id)
        # 这个接口对不存在的 id 也会返回成功（实测过），所以自己再回读确认一遍 ——
        # 不然界面上说"删掉了"，实际上还在，用户下次打开就懵了。
        still_there: Optional[bool] = None
        try:
            left = CTX.client.my_fav_folders(my_mid)
            still_there = any(int(f.get("id") or 0) == media_id for f in left)
        except BiliError:
            still_there = None      # 读不到就别下结论，当成功处理
        if still_there:
            hub.log("复查时它还在，多半没删成功", "error")
            return {
                "ok": False, "reason": "failed",
                "message": f"「{src_title}」似乎没删掉，去 B 站网页上确认一下",
            }
        hub.log("收藏夹已经删掉了", "ok")
        return {
            "ok": True, "reason": "finished",
            "message": (f"「{src_title}」已删除，里面的 {moved} 条搬去别处了"
                        if moved else f"「{src_title}」已删除"),
        }

    label = f"删收藏夹 · {src_title}"
    ok, message = HUB.start("folder", label, work)
    if not ok:
        return {"ok": False, "error": message}
    session_log(f"删除收藏夹 {media_id}（内容搬去 {move_to or '无'}）")
    return {"ok": True, "message": message}


def api_folder_clean_all(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """把账号下**所有**收藏夹的失效内容都清一遍。"""
    err = require_login()
    if err:
        return need_login_payload()
    try:
        account = CTX.client.my_account()
        if not account.get("is_login"):
            return need_login_payload()
        folders = CTX.client.my_fav_folders(int(account["mid"]))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}
    targets = [
        {"media_id": int(f.get("id") or 0), "title": str(f.get("title") or "")}
        for f in folders if int(f.get("id") or 0)
    ]
    if not targets:
        return {"ok": False, "error": "这个账号下还没有收藏夹"}

    def work(hub: TaskHub) -> Dict[str, Any]:
        good, fail = 0, 0
        for index, f in enumerate(targets, start=1):
            hub.log(f"[{index}/{len(targets)}] 清理「{f['title']}」…")
            try:
                clear_folder_cache(f["media_id"])
                CTX.client.fav_clean(f["media_id"])
                good += 1
            except RiskControlError:
                raise
            except BiliError as exc:
                fail += 1
                hub.log(f"「{f['title']}」没清成：{exc}", "warn")
            hub.update_extra(stats={"total": len(targets), "done": index})
        hub.log(
            f"清完了：{good} 个成功" + (f"，{fail} 个没清成" if fail else ""), "ok"
        )
        return {
            "ok": True, "reason": "finished",
            "message": f"已经让 B 站清理了 {good} 个收藏夹的失效内容",
        }

    ok, message = HUB.start("folder", f"批量清理失效 · {len(targets)} 个收藏夹", work)
    if not ok:
        return {"ok": False, "error": message}
    session_log(f"批量清理失效内容：{len(targets)} 个收藏夹")
    return {"ok": True, "message": message}


# ---------------- 复制任务 ----------------
def api_copy_start(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    err = require_login()
    if err:
        return need_login_payload()

    source_id = int(body.get("source_media_id") or 0)
    target_id = int(body.get("target_media_id") or 0)
    if not source_id or not target_id:
        return {"ok": False, "error": "源收藏夹和目标收藏夹都得选好"}
    if source_id == target_id:
        return {"ok": False, "error": "源和目标撞在同一个收藏夹上了，换一个吧"}

    options = body.get("options") or {}

    def _num(key: str, default: float, low: float, high: float) -> float:
        try:
            value = float(options.get(key, default))
        except (TypeError, ValueError):
            value = default
        return max(low, min(high, value))

    opts = CopyOptions(
        order=str(options.get("order") or "mtime"),
        content_type=int(options.get("content_type") or 2),
        batch_size=max(1, min(20, int(options.get("batch_size") or 1))),
        delay=_num("delay", 1.5, 0.3, 15.0),
        jitter=_num("jitter", 0.6, 0.0, 8.0),
        skip_invalid=bool(options.get("skip_invalid", True)),
        prescan_target=bool(options.get("prescan_target", True)),
        max_consecutive_failures=int(options.get("max_consecutive_failures") or 12),
    )

    try:
        account = CTX.client.my_account()
        if not account.get("is_login"):
            return need_login_payload()
        my_mid = int(account["mid"])
        src_info = CTX.client.fav_folder_info(source_id)
        tgt_info = CTX.client.fav_folder_info(target_id)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}

    if not src_info:
        return {"ok": False, "error": "源收藏夹读不到，检查一下 ID"}
    if not tgt_info:
        return {"ok": False, "error": "目标收藏夹读不到，它得是你自己账号下的收藏夹"}
    if int(tgt_info.get("mid") or 0) != my_mid:
        return {"ok": False, "error": "目标收藏夹不是你的，只能往自己的收藏夹里搬"}

    source = _folder_brief(src_info)
    target = _folder_brief(tgt_info)
    state_path = CopyState.state_path_for(state_dir(), source_id, target_id)

    def work(hub: TaskHub) -> Dict[str, Any]:
        hub.log(f"要把「{source['title']}」里的内容搬到你的「{target['title']}」")
        hub.update_extra(source=source, target=target)
        state = CopyState.load_or_new(state_path, source, target, my_mid)
        summary = state.summary()
        if summary["total"]:
            hub.log(
                f"发现上次的进度：清单 {summary['total']} 条，"
                f"已完成 {summary['done'] + summary['duplicate'] + summary['invalid']} 条，"
                f"剩余 {summary['remaining']} 条，接着跑"
            )
        engine = CopyEngine(CTX.client, state, opts, emit=hub.emit)
        hub.attach(engine)
        try:
            reason = engine.run()
        finally:
            clear_folder_cache(target_id)
        ok = reason == "finished"
        hub.update_extra(stats=state.summary(), state_file=str(state_path.name))
        return {
            "ok": ok,
            "reason": reason,
            "message": {
                "finished": "搬完啦",
                "cancelled": "停下来了，进度都存着，下次接着跑",
                "risk": "被风控拦住了，歇一会儿再继续",
                "auth": "登录态失效，重新登录后可以接着跑",
                "stopped": "触发了保护性熔断，检查后可以继续",
                "error": "出错了，但进度已保存",
            }.get(reason, reason),
        }

    ok, message = HUB.start("copy", f"复制 → {target['title']}", work)
    if not ok:
        return {"ok": False, "error": message}
    session_log(f"启动复制任务：{source_id} → {target_id}")
    return {"ok": True, "message": message, "source": source, "target": target}


# ---------------- 整理顺序 / 增删条目 ----------------
def _video_brief(detail: Dict[str, Any]) -> Dict[str, Any]:
    """把 view 接口返回的视频，整理成界面上「待添加」条目的样子。"""
    owner = detail.get("owner") if isinstance(detail.get("owner"), dict) else {}
    stat = detail.get("stat") if isinstance(detail.get("stat"), dict) else {}
    title = str(detail.get("title") or "").strip()
    upper = str(owner.get("name") or "").strip()
    avid = int(detail.get("aid") or 0)
    return {
        "key": f"{avid}:2",
        "avid": avid,
        "type": 2,
        "bvid": str(detail.get("bvid") or ""),
        "title": title,
        "upper": upper,
        "upper_info": {"mid": int(owner.get("mid") or 0), "name": upper,
                       "face": str(owner.get("face") or "")},
        "duration": int(detail.get("duration") or 0),
        "pubtime": int(detail.get("pubdate") or 0),
        "fav_time": 0,
        "play": int(stat.get("view") or 0),
        "danmaku": int(stat.get("danmaku") or 0),
        "collect": int(stat.get("favorite") or 0),
        "cover": str(detail.get("pic") or ""),
        "invalid": False,
        "py": pinyin_sort_key(title),
        "py_upper": pinyin_sort_key(upper),
        "is_new": True,          # 界面上据此打个「新增」标记
    }


def api_video_resolve(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    解析用户贴进来的一坨内容，把里面的 BV 号 / av 号都查出来。

    支持一次贴多个、也支持整条链接。查不到的就单独列出来，不打断其余部分。
    """
    raw = str(body.get("input") or "").strip()
    if not raw:
        return {"ok": False, "error": "把 BV 号、av 号或者视频链接贴进来呀"}

    bvids, avids = parse_video_ids(raw)
    total = len(bvids) + len(avids)
    if not total:
        return {"ok": False, "error": "没认出来 BV 号或者 av 号，检查一下？"}
    if total > 50:
        return {"ok": False, "error": f"一次最多 50 个，你贴了 {total} 个，分几批来吧"}

    CTX.ensure_loaded()
    CTX.client.bootstrap()

    found: List[Dict[str, Any]] = []
    failed: List[Dict[str, str]] = []
    seen: set = set()

    def _one(bvid: str = "", avid: int = 0, label: str = "") -> None:
        try:
            detail = CTX.client.video_detail(bvid=bvid, avid=avid)
        except Exception as exc:  # noqa: BLE001
            failed.append({"input": label, "why": friendly_error(exc)})
            return
        item = _video_brief(detail) if detail else {}
        if not item.get("avid"):
            failed.append({"input": label, "why": "找不到这个视频，可能是 BV 号写错了"})
            return
        if item["key"] in seen:
            return
        seen.add(item["key"])
        found.append(item)

    # 查视频详情是**纯只读**接口（连登录都不需要），一次贴几十个的时候
    # 别按搬运的节奏慢慢等 —— 实测 50 个从 51 秒降到十几秒。
    with CTX.client.faster(0.3):
        for bvid in bvids:
            _one(bvid=bvid, label=bvid)
        for avid in avids:
            _one(avid=avid, label=f"av{avid}")

    return {"ok": True, "found": found, "failed": failed}


def api_sort_apply(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    err = require_login()
    if err:
        return need_login_payload()

    media_id = int(body.get("media_id") or 0)
    original = [str(x) for x in (body.get("original") or [])]
    target = [str(x) for x in (body.get("target") or [])]
    deletions = [str(x) for x in (body.get("deletions") or [])]
    additions = [a for a in (body.get("additions") or []) if isinstance(a, dict)]

    if not media_id:
        return {"ok": False, "error": "缺少收藏夹 ID"}
    if not target and not deletions:
        return {"ok": False, "error": "没有要提交的改动呀"}
    # 纯排序必须给原始顺序（增量操作得靠它算）；
    # 有增删的话不用给，服务端会重新读一遍真实顺序。
    if not (deletions or additions) and not original:
        return {"ok": False, "error": "缺少原始顺序，重新加载一次收藏夹再试"}

    try:
        account = CTX.client.my_account()
        if not account.get("is_login"):
            return need_login_payload()
        info = CTX.client.fav_folder_info(media_id)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}

    if not info:
        return {"ok": False, "error": "读不到这个收藏夹"}
    if int(info.get("mid") or 0) != int(account["mid"]):
        return {"ok": False, "error": "只能改自己账号下的收藏夹"}

    folder = _folder_brief(info)
    batch_size = max(20, min(500, int(body.get("batch_size") or 200)))
    # 纯排序时能提前算出移动次数；带增删的话要等重读之后才知道
    planned_ops = 0 if (deletions or additions) else len(build_move_ops(original, target))

    def work(hub: TaskHub) -> Dict[str, Any]:
        parts = []
        if deletions:
            parts.append(f"删除 {len(deletions)} 条")
        if additions:
            parts.append(f"添加 {len(additions)} 条")
        if planned_ops:
            parts.append(f"移动 {planned_ops} 次")
        hub.log(f"开始处理「{folder['title']}」：" + ("、".join(parts) or "没有改动"))
        hub.update_extra(folder=folder)
        if body.get("baseline_cached"):
            hub.log("先核对缓存基线，确认后才执行写入…")
            with CTX.client.faster(0.25, jitter=0.05):
                raw = CTX.client.fav_resource_all(media_id)
            live_items = normalize_items(raw)
            if [it["key"] for it in live_items] != original:
                write_folder_cache(media_id, folder, live_items)
                return {"ok": False, "reason": "stale", "message": "线上内容或顺序已有变化，本次没有写入。请先导出保留本地清单，再刷新核对。"}
        applier = SortApplier(CTX.client, hub.emit, batch_size=batch_size)
        hub.attach(applier)
        result = applier.run(media_id, original, target, deletions, additions)
        # 成功的提交留一份快照，之后才发现排错了还能倒回来
        if result.get("ok") and result.get("reason") != "noop":
            record_commit(
                media_id, folder["title"],
                applier.before_keys, applier.after_keys,
                deleted=len(deletions), added=len(additions),
                ops=int(result.get("ops") or 0),
            )
            # 顺序动过了，缓存里那份已经不对，删掉。
            # 下次打开会重新读一遍（慢一点，但至少是对的）。
            clear_folder_cache(media_id)
        return result

    tags = []
    if deletions:
        tags.append(f"删{len(deletions)}")
    if additions:
        tags.append(f"加{len(additions)}")
    if planned_ops:
        tags.append(f"排{planned_ops}")
    label = f"整理 · {folder['title']}" + (f"（{'/'.join(tags)}）" if tags else "")

    ok, message = HUB.start("sort", label, work)
    if not ok:
        return {"ok": False, "error": message}
    session_log(
        f"提交整理：{media_id}，删 {len(deletions)} / 加 {len(additions)} / 移动 {planned_ops}"
    )
    return {
        "ok": True, "message": message, "folder": folder, "ops": planned_ops,
        "deletions": len(deletions), "additions": len(additions),
    }


def api_sort_strategies(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": True, "strategies": SORT_STRATEGIES}


# ---------------- 任务控制 ----------------
def api_task_status(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    since = int(query.get("since") or 0)
    return {"ok": True, **HUB.snapshot(since)}


def api_task_control(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    action = str(body.get("action") or "").strip()
    if action not in ("pause", "resume", "stop"):
        return {"ok": False, "error": f"不认识的操作：{action}"}
    ok, message = HUB.control(action)
    return {"ok": ok, "message": message, "error": None if ok else message}


# ---------------- 诊断 / 杂项 ----------------
def api_system_theme(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    return system_theme()


def api_health(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    CTX.ensure_loaded()
    return {
        "ok": True,
        "version": __version__,
        "logged_in": CTX.client.has_session,
        "pinyin": pinyin_stats(),
        "state_dir": str(state_dir()),
        # 数据到底放在哪儿 —— 界面照实显示，用户一眼能看到，
        # 不用去猜有没有被悄悄塞到 C 盘。
        "data_dir": str(data_root()),
        "portable": data_root_is_portable(),
    }


def api_exports(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """列出本地的任务状态文件，方便用户找回进度或导出对账表。"""
    out = []
    try:
        for path in sorted(state_dir().glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                state = CopyState.load(path)
                out.append(
                    {
                        "name": path.name,
                        "source": state.data.get("source", {}).get("title", ""),
                        "target": state.data.get("target", {}).get("title", ""),
                        "updated_at": state.data.get("updated_at", ""),
                        **state.summary(),
                    }
                )
            except Exception:  # noqa: BLE001 - 坏文件跳过就好
                continue
    except OSError:
        pass
    return {"ok": True, "tasks": out}


def api_export_csv(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    name = str(body.get("name") or "").strip()
    if not name or "/" in name or "\\" in name or not name.endswith(".json"):
        return {"ok": False, "error": "文件名不合法"}
    path = state_dir() / name
    if not path.exists():
        return {"ok": False, "error": "找不到这个任务记录"}
    try:
        state = CopyState.load(path)
        out = state_dir() / (name[:-5] + ".csv")
        state.export_list(out)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"导出失败：{exc}"}
    return {"ok": True, "path": str(out)}


# ---------------- 提交历史（给「回滚上次提交」用） ----------------
# 「撤销一步」只在**没提交**时管用。提交完才发现排错了，就得靠这里 ——
# 每次提交成功都往 data/history/commits.json 追加一条"改动前 / 改动后"的快照，
# 只留最近 20 条。
#
# 回滚**只倒顺序**：B 站没有"恢复已删除视频"这回事，所以那次提交如果删过东西，
# 顺序能倒回来、删掉的回不来，接口会如实说明。
_COMMITS_LOCK = threading.Lock()
_COMMITS_KEEP = 20


def _commits_file() -> Path:
    return history_dir() / "commits.json"


def _load_commits() -> List[Dict[str, Any]]:
    path = _commits_file()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = data.get("commits") if isinstance(data, dict) else None
    return items if isinstance(items, list) else []


def _save_commits(items: List[Dict[str, Any]]) -> None:
    path = _commits_file()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"commits": items[-_COMMITS_KEEP:]}, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    tmp.replace(path)


def record_commit(media_id: int, title: str, before: Sequence[str], after: Sequence[str],
                  deleted: int = 0, added: int = 0, ops: int = 0) -> None:
    """把一次成功的提交记进历史。写不进去也不该让提交本身失败，所以吞掉异常。"""
    if not before and not after:
        return
    entry = {
        "id": datetime.now().strftime("%Y%m%d-%H%M%S"),
        "ts": int(time.time()),
        "media_id": int(media_id),
        "title": str(title or "收藏夹"),
        "before": [str(k) for k in before],
        "after": [str(k) for k in after],
        "deleted": int(deleted),
        "added": int(added),
        "ops": int(ops),
        "rolled_back": False,
    }
    try:
        with _COMMITS_LOCK:
            items = _load_commits()
            items.append(entry)
            _save_commits(items)
    except OSError:
        pass


def api_commits(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """最近几次提交。前端拿它决定"回滚"按钮能不能点。"""
    out = []
    for it in reversed(_load_commits()[-10:]):
        out.append({
            "id": it.get("id"),
            "ts": it.get("ts"),
            "media_id": it.get("media_id"),
            "title": it.get("title"),
            "count": len(it.get("before") or []),
            "deleted": it.get("deleted") or 0,
            "added": it.get("added") or 0,
            "ops": it.get("ops") or 0,
            "rolled_back": bool(it.get("rolled_back")),
        })
    return {"ok": True, "commits": out}


def api_sort_rollback(body: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
    """
    把「上一次提交」的顺序倒回去。

    做法很直接：那次提交留下了改动前的快照，把**现在的真实顺序**读出来，
    再算一遍从"现在"到"当初"需要哪些移动，交给同一套 SortApplier 执行。
    """
    err = require_login()
    if err:
        return need_login_payload()

    commit_id = str(body.get("id") or "").strip()
    with _COMMITS_LOCK:
        items = _load_commits()

    target = None
    if commit_id:
        for it in items:
            if str(it.get("id")) == commit_id:
                target = it
                break
    else:
        for it in reversed(items):
            if not it.get("rolled_back"):
                target = it
                break

    if not target:
        return {"ok": False, "error": "没有可以回滚的提交记录"}
    if target.get("rolled_back"):
        return {"ok": False, "error": "这次提交已经回滚过了"}

    media_id = int(target.get("media_id") or 0)
    want = [str(k) for k in (target.get("before") or [])]
    if not media_id or not want:
        return {"ok": False, "error": "这条记录不完整，倒不回去"}

    try:
        account = CTX.client.my_account()
        if not account.get("is_login"):
            return need_login_payload()
        info = CTX.client.fav_folder_info(media_id)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": friendly_error(exc)}

    if not info:
        return {"ok": False, "error": "读不到这个收藏夹了"}
    if int(info.get("mid") or 0) != int(account["mid"]):
        return {"ok": False, "error": "只能改自己账号下的收藏夹"}

    folder = _folder_brief(info)
    title = folder["title"]

    def work(hub: TaskHub) -> Dict[str, Any]:
        hub.log(f"准备把「{title}」倒回 {target.get('id')} 提交之前的样子")
        try:
            with CTX.client.faster(0.5):
                raws = CTX.client.fav_resource_all(media_id, order="mtime")
            current = [item_key(r) for r in raws]
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "api", "message": friendly_error(exc)}

        hub.log(f"现在线上 {len(current)} 条，要倒回去的是 {len(want)} 条")
        applier = SortApplier(CTX.client, hub.emit, batch_size=200)
        hub.attach(applier)
        result = applier.run(media_id, current, want)
        if result.get("ok"):
            # 标成已回滚，免得手一抖倒两次
            with _COMMITS_LOCK:
                fresh = _load_commits()
                for it in fresh:
                    if str(it.get("id")) == str(target.get("id")):
                        it["rolled_back"] = True
                        it["rolled_back_at"] = int(time.time())
                try:
                    _save_commits(fresh)
                except OSError:
                    pass
            # 倒回去之后顺序也变了，缓存同样作废
            clear_folder_cache(media_id)
        return result

    label = f"回滚 · {title}"
    ok, message = HUB.start("sort", label, work)
    if not ok:
        return {"ok": False, "error": message}
    session_log(f"回滚提交：{target.get('id')}，收藏夹 {media_id}")
    return {
        "ok": True, "message": message, "folder": folder,
        "commit": target.get("id"), "count": len(want),
    }


# ==========================================================================
# 路由表
# ==========================================================================
ROUTES: Dict[str, Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]] = {
    "/api/account": api_account,
    "/api/login/qr": api_login_qr,
    "/api/login/qr/poll": api_login_qr_poll,
    "/api/login/cookie": api_login_cookie,
    "/api/logout": api_logout,
    "/api/folder/resolve": api_folder_resolve,
    "/api/up/search": api_up_search,
    "/api/up/folders": api_up_folders,
    "/api/folders/mine": api_my_folders,
    "/api/folder/create": api_folder_create,
    "/api/folder/items": api_folder_items,
    "/api/open-browser": api_open_browser,
    "/api/open-external": api_open_external,
    "/api/folder/add-items": api_folder_add_items,
    "/api/folder/cache": api_folder_cache,
    "/api/folder/search-cache": api_folder_search_cache,
    "/api/folder/edit": api_folder_edit,
    "/api/folder/clean": api_folder_clean,
    "/api/folder/clean-all": api_folder_clean_all,
    "/api/folder/delete": api_folder_delete,
    "/api/folder/move": api_folder_move,
    "/api/folder/merge": api_folder_merge,
    "/api/folder/export": api_folder_export,
    "/api/prefs": api_prefs_get,
    "/api/prefs/set": api_prefs_set,
    "/api/prefs/ui-patch": api_prefs_ui_patch,
    "/api/draft/save": api_draft_save,
    "/api/draft/load": api_draft_load,
    "/api/draft/clear": api_draft_clear,
    "/api/video/resolve": api_video_resolve,
    "/api/video/search": api_video_search,
    "/api/video/tags": api_video_tags,
    "/api/video/info": api_video_info,
    "/api/copy/start": api_copy_start,
    "/api/sort/apply": api_sort_apply,
    "/api/sort/rollback": api_sort_rollback,
    "/api/commits": api_commits,
    "/api/sort/strategies": api_sort_strategies,
    "/api/task/status": api_task_status,
    "/api/task/control": api_task_control,
    "/api/health": api_health,
    "/api/system/theme": api_system_theme,
    "/api/tasks": api_exports,
    "/api/export/csv": api_export_csv,
}

# 只读接口允许 GET，写操作一律 POST
GET_ONLY = {"/api/account", "/api/login/qr", "/api/login/qr/poll", "/api/folder/items",
            "/api/folder/cache",
            "/api/folders/mine", "/api/task/status", "/api/health", "/api/tasks",
            "/api/up/search", "/api/up/folders", "/api/video/search", "/api/video/tags",
            "/api/video/info", "/api/draft/load", "/api/prefs",
            "/api/sort/strategies", "/api/system/theme"}


# ==========================================================================
# HTTP Handler
# ==========================================================================
class Handler(BaseHTTPRequestHandler):
    server_version = f"BiliFavStudio/{__version__}"
    protocol_version = "HTTP/1.1"

    # ---------------- 基础设施 ----------------
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        """默认的访问日志太吵，关掉；需要排查时看 logs 目录。"""
        return

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload: Dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _text(self, text: str, status: int = 200, ctype: str = "text/plain; charset=utf-8") -> None:
        self._send(status, text.encode("utf-8"), ctype)

    def _same_origin(self) -> bool:
        """挡掉别的网页对我们本地服务发起的请求。"""
        for header in ("Origin", "Referer"):
            value = self.headers.get(header)
            if not value:
                continue
            host = urlparse(value).hostname or ""
            if host not in ("127.0.0.1", "localhost", "::1"):
                return False
        return True

    def _token_ok(self) -> bool:
        if not self.server.token:  # type: ignore[attr-defined]
            return True
        given = self.headers.get("X-Token") or ""
        if not given:
            query = parse_qs(urlparse(self.path).query)
            given = (query.get("token") or [""])[0]
        return secrets.compare_digest(given, self.server.token)  # type: ignore[attr-defined]

    def _read_body(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if length <= 0:
            return {}
        if length > 8 * 1024 * 1024:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    # ---------------- 静态资源 ----------------
    def _serve_static(self, path: str) -> bool:
        if path in ("/", "/index.html"):
            target = WEB_DIR / "index.html"
        elif path.startswith("/static/"):
            target = WEB_DIR / path[len("/static/"):]
        else:
            return False

        try:
            resolved = target.resolve()
            if not str(resolved).startswith(str(WEB_DIR.resolve())):
                self._text("403", 403)
                return True
            if not resolved.is_file():
                return False
            payload = resolved.read_bytes()
        except OSError:
            return False

        guess, _ = mimetypes.guess_type(str(resolved))
        if resolved.suffix == ".html":
            # 把 token 注入页面，前端后续请求带着它
            text = payload.decode("utf-8").replace("__DSH_TOKEN__", self.server.token)  # type: ignore[attr-defined]
            payload = text.encode("utf-8")
            guess = "text/html"
        self._send(200, payload, (guess or "application/octet-stream") + "; charset=utf-8"
                   if (guess or "").startswith(("text", "application/json", "image/svg")) else (guess or "application/octet-stream"))
        return True

    # ---------------- 分发 ----------------
    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}

        if method == "GET" and not path.startswith("/api/"):
            if self._serve_static(path):
                return
            self._text("404 Not Found", 404)
            return

        handler = ROUTES.get(path)
        if handler is None:
            self._json({"ok": False, "error": f"没有这个接口：{path}"}, 404)
            return
        if method == "GET" and path not in GET_ONLY:
            self._json({"ok": False, "error": "这个接口只接受 POST"}, 405)
            return
        if not self._same_origin():
            self._json({"ok": False, "error": "拒绝跨站请求"}, 403)
            return
        if not self._token_ok():
            self._json({"ok": False, "error": "token 不对，刷新一下页面"}, 403)
            return

        body = self._read_body() if method == "POST" else {}
        try:
            result = handler(body, query)
        except Exception as exc:  # noqa: BLE001 - 绝不让一个异常打挂服务
            self._json({"ok": False, "error": friendly_error(exc),
                        "detail": traceback.format_exc(limit=4)}, 500)
            return
        self._json(result)

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: Tuple[str, int], handler: Any, token: str):
        self.token = token
        super().__init__(address, handler)


# ==========================================================================
# 启动
# ==========================================================================
def find_port(host: str, preferred: int, tries: int = 20) -> int:
    """
    从 preferred 开始往后找一个能用的端口。

    只在用户**显式指定**了端口时才会走到这里；默认情况下端口是交给操作系统
    随机分配的（见 create_server），那样最省心也不会撞车。
    """
    import socket

    for offset in range(tries):
        port = preferred + offset
        if port > 65535:
            break
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"{preferred} 往后 {tries} 个端口都被占用了")


def create_server(
    host: str = DEFAULT_HOST,
    port: Optional[int] = None,
) -> Tuple[Server, str]:
    """
    把 HTTP 服务建好但先不跑，返回 (httpd, 界面地址)。

    端口策略：**默认让操作系统挑一个空闲端口**（等价于随机，绝不会跟别的程序撞车，
    也不容易被本机其它东西猜到）；只有显式指定了端口才用那个，被占了就往后顺延。
    桌面版走的是前者，所以每次启动端口都不一样。
    """
    CTX.ensure_loaded()
    token = secrets.token_urlsafe(24)
    wanted = 0 if not port else find_port(host, int(port))
    httpd = Server((host, wanted), Handler, token)
    real_port = int(httpd.server_address[1])
    return httpd, f"http://{host}:{real_port}/"


def serve(
    host: str = DEFAULT_HOST,
    port: Optional[int] = None,
    open_browser: bool = True,
    quiet: bool = False,
) -> None:
    """命令行模式：起服务、开浏览器、一直跑着。"""
    httpd, url = create_server(host, port)

    if not quiet:
        has_session = CTX.client.has_session
        # 注意：别在这里用 emoji。中文 Windows 的控制台是 GBK，
        # 编不出来的字符会直接抛 UnicodeEncodeError 把程序搞崩。
        print("=" * 64)
        print("  BiliFav Studio   --   B 站收藏夹搬运与整理")
        print("=" * 64)
        print(f"  界面地址 : {url}")
        print(f"  登录状态 : {'已登录（会自动恢复）' if has_session else '未登录，打开页面扫码就行'}")
        print(f"  数据目录 : {state_dir()}")
        print("  关掉这个窗口就等于退出程序")
        print("=" * 64)

    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n收到退出信号，正在关闭…")
    finally:
        HUB.control("stop")
        httpd.server_close()
