# -*- coding: utf-8 -*-
"""
B 站 Web 接口客户端。

职责边界（重要）：
  * 只读取**公开可见**的收藏夹内容；
  * 只往**调用者自己账号**的收藏夹里添加条目，写操作全程使用调用者自己的
    Cookie（以 bili_jct 作为 csrf token）；
  * 不下载视频、不绕过任何权限校验。

工程上的重点：
  * 全局限速 + 随机抖动，避免触发风控；
  * 可重试错误自动指数退避；
  * 命中风控（HTTP 412 / code -352 / -412）立即抛 RiskControlError 熔断；
  * 所有 sleep 都可被 cancel 事件打断，保证界面上的"停止"立刻生效。
"""
from __future__ import annotations

import contextlib
import hashlib
import random
import threading
import time
import urllib.parse
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import requests

API_BASE = "https://api.bilibili.com"
PASSPORT_BASE = "https://passport.bilibili.com"
WEB_BASE = "https://www.bilibili.com"

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

# 收藏内容类型：2 = 视频，12 = 音频，21 = 视频合集
TYPE_VIDEO = 2
TYPE_AUDIO = 12
TYPE_SEASON = 21


# --------------------------------------------------------------------------
# 异常
# --------------------------------------------------------------------------
class BiliError(Exception):
    """接口返回 code != 0。"""

    def __init__(self, code: int, message: str = "", payload: Any = None):
        text = f"[{code}] {message}" if message else f"[{code}]"
        super().__init__(text)
        self.code = code
        self.message = message or ""
        self.payload = payload


class NotLoggedInError(BiliError):
    def __init__(self, message: str = "账号未登录，或登录态已失效"):
        super().__init__(-101, message)


class RiskControlError(BiliError):
    """被 B 站风控拦截。此时必须停下来冷却，继续重试只会让情况更糟。"""


class Cancelled(Exception):
    """用户主动中止。"""


# --------------------------------------------------------------------------
# WBI 签名（备用：部分接口在收紧后需要签名）
# --------------------------------------------------------------------------
_MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]


def _mixin_key(orig: str) -> str:
    return "".join(orig[i] for i in _MIXIN_KEY_ENC_TAB)[:32]


def _wbi_sign(params: Dict[str, Any], img_key: str, sub_key: str) -> Dict[str, Any]:
    """按 B 站 WBI 规则给参数加上 wts / w_rid。"""
    mixin = _mixin_key(img_key + sub_key)
    signed = {k: v for k, v in params.items() if v is not None}
    signed["wts"] = int(time.time())
    query = urllib.parse.urlencode(
        [
            (k, "".join(ch for ch in str(v) if ch not in "!'()*"))
            for k, v in sorted(signed.items())
        ]
    )
    signed["w_rid"] = hashlib.md5((query + mixin).encode("utf-8")).hexdigest()
    return signed


def _key_from_url(url: str) -> str:
    """从 wbi_img 的 URL 中取出文件名（不含扩展名）。"""
    name = url.rsplit("/", 1)[-1]
    return name.split(".", 1)[0]


def _pack_resources(resources: Iterable[Tuple[int, int]]) -> str:
    """把 (id, type) 序列打包成接口要求的 "id:type,id:type" 形式。"""
    return ",".join(f"{int(r)}:{int(t)}" for r, t in resources)


# --------------------------------------------------------------------------
# 客户端
# --------------------------------------------------------------------------
class BiliClient:
    """一个带限速与重试的 B 站接口客户端。"""

    def __init__(
        self,
        session: Optional[requests.Session] = None,
        delay: float = 1.5,
        jitter: float = 0.6,
        timeout: float = 15.0,
        log: Optional[Callable[[str, str], None]] = None,
        cancel: Optional[threading.Event] = None,
    ):
        self.s = session or requests.Session()
        self.s.headers.update(
            {
                "User-Agent": DEFAULT_UA,
                "Referer": WEB_BASE + "/",
                "Origin": WEB_BASE,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Connection": "keep-alive",
            }
        )
        self.delay = delay
        self.jitter = jitter
        self.timeout = timeout
        self.cancel = cancel
        self._log = log or (lambda msg, level="info": None)
        self._next_allowed = 0.0
        self._last_reserved = None
        self._bootstrapped = False
        self._wbi_keys: Optional[Tuple[str, str]] = None
        self._lock = threading.Lock()
        # 限速要单独一把锁：_lock 会被 bootstrap / 签名那几处复用，
        # 混在一起容易自己等自己。
        self._throttle_lock = threading.Lock()
        self._request_pace = threading.local()

    # ---------------- 基础设施 ----------------
    def set_cancel(self, event: threading.Event) -> None:
        self.cancel = event

    def set_delay(self, delay: float, jitter: Optional[float] = None) -> None:
        self.delay = max(0.0, delay)
        if jitter is not None:
            self.jitter = max(0.0, jitter)

    def log(self, msg: str, level: str = "info") -> None:
        self._log(msg, level)

    def _sleep(self, seconds: float) -> None:
        """可被打断的 sleep。"""
        if seconds <= 0:
            return
        deadline = time.monotonic() + seconds
        while True:
            if self.cancel is not None and self.cancel.is_set():
                raise Cancelled()
            remain = deadline - time.monotonic()
            if remain <= 0:
                return
            time.sleep(min(0.15, remain))

    def check_cancel(self) -> None:
        if self.cancel is not None and self.cancel.is_set():
            raise Cancelled()

    def _throttle(self) -> None:
        """
        全局限速。

        这里必须线程安全：服务端是多线程的，界面上也常有并发请求
        （比如自动匹配标签的同时还在读收藏夹）。如果两个线程同时读到
        "还没到点"，就会一起冲出去，等于把限速绕过去了。

        做法是先在锁里把下一个时间片占住，再出去睡自己的那一份。
        """
        with self._throttle_lock:
            pace = getattr(self._request_pace, "stack", ())
            delay, jit = pace[-1] if pace else (self.delay, self.jitter)
            now = time.monotonic()
            interval = delay + random.uniform(0.0, jit)
            # 相邻请求取双方节奏中较慢的一方，读请求不能缩短下一次普通写入的间隔。
            own_ready = now if self._last_reserved is None else self._last_reserved + interval
            base = max(now, self._next_allowed, own_ready)
            wait = base - now
            self._last_reserved = base
            self._next_allowed = base + interval
        if wait > 0:
            self._sleep(wait)

    @contextlib.contextmanager
    def faster(self, delay: float = 0.35, jitter: float = 0.0):
        """
        仅对当前请求线程临时使用指定节奏；嵌套和异常退出均恢复上一层。
        所有线程仍共用全局时间片锁，不增加并发、不绕过排队。
        """
        floor = max(0.0, float(delay))
        jit = max(0.0, float(jitter))
        stack = getattr(self._request_pace, "stack", None)
        if stack is None:
            stack = self._request_pace.stack = []
        stack.append((min(stack[-1][0], floor), min(stack[-1][1], jit)) if stack else (floor, jit))
        try:
            yield
        finally:
            stack.pop()

    def _backoff(self, attempt: int, reason: str) -> None:
        wait = min(90.0, (2 ** attempt) * 1.5) + random.uniform(0.0, 1.0)
        self.log(f"{reason}，{wait:.1f}s 后重试（第 {attempt + 1} 次）", "warn")
        self._sleep(wait)

    # ---------------- 请求 ----------------
    @property
    def csrf(self) -> str:
        return self.s.cookies.get("bili_jct", "")

    @property
    def has_session(self) -> bool:
        return bool(self.s.cookies.get("SESSDATA"))

    def _request(
        self,
        method: str,
        url: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        need_csrf: bool = False,
        signed: bool = False,
        retries: int = 4,
    ) -> Any:
        if need_csrf:
            token = self.csrf
            if not token:
                raise NotLoggedInError("缺少 bili_jct，写操作需要它作为 csrf token")
            data = dict(data or {})
            data["csrf"] = token
        if signed:
            params = self._sign(params or {})

        last_error: Optional[Exception] = None

        for attempt in range(retries + 1):
            self.check_cancel()
            self._throttle()
            try:
                resp = self.s.request(
                    method, url, params=params, data=data, timeout=self.timeout
                )
            except requests.RequestException as exc:
                last_error = exc
                if attempt >= retries:
                    break
                self._backoff(attempt, f"网络异常（{type(exc).__name__}）")
                continue

            if resp.status_code == 412:
                raise RiskControlError(412, "触发 B 站风控（HTTP 412），请冷却至少 30 分钟")
            if resp.status_code in (429, 500, 502, 503, 504):
                last_error = BiliError(resp.status_code, f"HTTP {resp.status_code}")
                if attempt >= retries:
                    break
                self._backoff(attempt, f"服务端返回 {resp.status_code}")
                continue
            if resp.status_code != 200:
                raise BiliError(resp.status_code, f"HTTP {resp.status_code}")

            try:
                payload = resp.json()
            except ValueError:
                raise BiliError(-1, f"响应不是合法 JSON：{resp.text[:160]!r}")

            code = int(payload.get("code", 0))
            message = str(payload.get("message") or payload.get("msg") or "")

            if code == 0:
                return payload.get("data")

            if code in (-352, -412):
                raise RiskControlError(code, message or "风控校验失败")

            if code == -101:
                raise NotLoggedInError(message or "账号未登录，或登录态已失效")

            # 这类是"稍后再试"型的错误，退避重试
            if code in (-509, -799, -504, -503) and attempt < retries:
                last_error = BiliError(code, message)
                self._backoff(attempt, f"接口限流 {message or code}")
                continue

            raise BiliError(code, message, payload)

        if isinstance(last_error, BiliError):
            raise last_error
        raise BiliError(-1, f"重试 {retries} 次后仍然失败：{last_error}")

    def _sign(self, params: Dict[str, Any]) -> Dict[str, Any]:
        keys = self._get_wbi_keys()
        if not keys:
            return params
        return _wbi_sign(params, keys[0], keys[1])

    def _get_wbi_keys(self) -> Optional[Tuple[str, str]]:
        if self._wbi_keys is not None:
            return self._wbi_keys
        try:
            data = self._request("GET", f"{API_BASE}/x/web-interface/nav", retries=1)
        except BiliError:
            return None
        nav = data or {}
        wbi = (nav.get("wbi_img") or {}) if isinstance(nav, dict) else {}
        img = _key_from_url(wbi.get("img_url", "") or "")
        sub = _key_from_url(wbi.get("sub_url", "") or "")
        if img and sub:
            self._wbi_keys = (img, sub)
            return self._wbi_keys
        return None

    # ---------------- 登录态 ----------------
    def bootstrap(self) -> None:
        """取一次设备指纹（buvid3/buvid4），降低被风控的概率。失败不影响使用。"""
        with self._lock:
            if self._bootstrapped:
                return
            self._bootstrapped = True
        try:
            data = self._request(
                "GET", f"{API_BASE}/x/frontend/finger/spi", retries=1
            )
        except BiliError:
            return
        if isinstance(data, dict):
            for cookie_name, field in (("buvid3", "b_3"), ("buvid4", "b_4")):
                value = data.get(field)
                if value:
                    self.s.cookies.set(cookie_name, value, domain=".bilibili.com")

    def nav(self) -> Dict[str, Any]:
        """当前登录用户信息。未登录时返回 isLogin=False，不抛异常。"""
        try:
            data = self._request("GET", f"{API_BASE}/x/web-interface/nav")
        except BiliError:
            data = self._request("GET", f"{API_BASE}/x/web-interface/nav", signed=True)
        return data if isinstance(data, dict) else {}

    def my_account(self, max_age: float = 0.0) -> Dict[str, Any]:
        """可短暂复用已验证身份；缓存与登录凭证绑定，默认仍强制核验。"""
        identity = hashlib.sha256(repr(sorted(
            (c.domain, c.path, c.name, c.value) for c in self.s.cookies
            if c.name in ("SESSDATA", "bili_jct", "DedeUserID")
        )).encode("utf-8")).digest()
        cached = getattr(self, "_account_cache", None)
        if (max_age > 0 and cached and cached[0] == identity
                and time.monotonic() - cached[1] <= min(float(max_age), 60.0)):
            return dict(cached[2])
        account = self._read_account()
        self._account_cache = (identity, time.monotonic(), dict(account)) if account.get("is_login") else None
        return account

    def _read_account(self) -> Dict[str, Any]:
        """返回 {is_login, mid, uname, face}。"""
        nav = self.nav()
        if nav.get("isLogin"):
            return {
                "is_login": True,
                "mid": int(nav.get("mid") or 0),
                "uname": nav.get("uname") or "",
                "face": nav.get("face") or "",
            }
        # 兜底：有些账号 nav 返回异常但 myinfo 正常
        if self.has_session:
            try:
                info = self._request("GET", f"{API_BASE}/x/space/myinfo")
                if isinstance(info, dict) and info.get("mid"):
                    return {
                        "is_login": True,
                        "mid": int(info["mid"]),
                        "uname": info.get("name") or "",
                        "face": info.get("face") or "",
                    }
            except BiliError:
                pass
        return {"is_login": False, "mid": 0, "uname": "", "face": ""}

    # ---------------- UP 主 ----------------
    def user_info(self, mid: int) -> Dict[str, Any]:
        """某个 UP 主的空间信息（昵称、头像、粉丝数、认证）。"""
        mid = int(mid)
        try:
            data = self._request(
                "GET", f"{API_BASE}/x/space/wbi/acc/info", params=self._sign({"mid": mid})
            )
            if isinstance(data, dict) and data.get("mid"):
                return data
        except BiliError:
            pass
        # 兜底：老接口，偶尔风控松一点
        data = self._request("GET", f"{API_BASE}/x/space/acc/info", params={"mid": mid})
        return data if isinstance(data, dict) else {}

    def user_fans(self, mid: int) -> int:
        """粉丝数。空间信息接口不给这个，得单独问一次关系接口。"""
        try:
            data = self._request(
                "GET", f"{API_BASE}/x/relation/stat", params={"vmid": int(mid)}
            )
        except BiliError:
            return 0
        if isinstance(data, dict):
            try:
                return int(data.get("follower") or 0)
            except (TypeError, ValueError):
                return 0
        return 0

    def user_fav_folders(self, mid: int) -> List[Dict[str, Any]]:
        """
        某个 UP 主「公开」的收藏夹列表。

        created/list-all 一次就把这人建的收藏夹列全了，私密的本来就不会出现在里面 ——
        正好就是我们要的"已公开收藏夹"，而且不用登录也能查。
        """
        data = self._request(
            "GET", f"{API_BASE}/x/v3/fav/folder/created/list-all",
            params={"up_mid": int(mid)},
        )
        if isinstance(data, dict):
            items = data.get("list")
            if isinstance(items, list):
                return [x for x in items if isinstance(x, dict)]
        return []

    def search_user(self, keyword: str) -> List[Dict[str, Any]]:
        """按昵称搜 UP 主。走网页搜索接口，命中率看 B 站心情，失败就返回空。"""
        try:
            data = self._request(
                "GET", f"{API_BASE}/x/web-interface/search/type",
                params={"search_type": "bili_user", "keyword": keyword, "page": 1},
            )
        except BiliError:
            return []
        result = (data or {}).get("result") if isinstance(data, dict) else None
        if isinstance(result, list):
            return [x for x in result if isinstance(x, dict)]
        return []

    def search_video(self, keyword: str, page: int = 1) -> List[Dict[str, Any]]:
        """按标题搜视频。命中率看 B 站心情，失败就返回空。"""
        try:
            data = self._request(
                "GET", f"{API_BASE}/x/web-interface/search/type",
                params={"search_type": "video", "keyword": keyword, "page": page},
            )
        except BiliError:
            return []
        result = (data or {}).get("result") if isinstance(data, dict) else None
        if isinstance(result, list):
            return [x for x in result if isinstance(x, dict)]
        return []

    def video_tags(self, bvid: str) -> List[str]:
        """某个视频在 B 站上的标签名。拿不到就返回空。"""
        try:
            data = self._request(
                "GET", f"{API_BASE}/x/tag/archive/tags", params={"bvid": bvid}
            )
        except BiliError:
            return []
        if isinstance(data, list):
            out = []
            for x in data:
                if isinstance(x, dict) and x.get("tag_name"):
                    out.append(str(x["tag_name"]))
            return out
        return []

    def video_owner(self, bvid: str) -> Dict[str, Any]:
        """视频的 UP 主信息（mid / 昵称 / 头像）。拿不到就返回空。"""
        try:
            data = self._request(
                "GET", f"{API_BASE}/x/web-interface/view", params={"bvid": bvid}
            )
        except BiliError:
            return {}
        if isinstance(data, dict) and isinstance(data.get("owner"), dict):
            return data["owner"]
        return {}

    # ---------------- 收藏夹：读 ----------------
    def fav_folder_info(self, media_id: int) -> Dict[str, Any]:
        """收藏夹基本信息（标题、条目数、UP 主）。"""
        data = self._request(
            "GET", f"{API_BASE}/x/v3/fav/folder/info", params={"media_id": int(media_id)}
        )
        return data if isinstance(data, dict) else {}

    def fav_resource_list(
        self,
        media_id: int,
        pn: int = 1,
        ps: int = 20,
        order: str = "mtime",
        content_type: int = 0,
        keyword: str = "",
        tid: int = 0,
    ) -> Dict[str, Any]:
        """
        收藏夹内容明细（分页）。

        order: mtime(收藏时间) / view(播放量) / pubtime(投稿时间)
        content_type: 0 全部 / 2 视频 / 12 音频 / 21 合集
        ps: 每页条数。**实测上限是 40，不是 20** —— 这里原来写死 min(20, ps)，
            把 40 又夹回 20 了，所以"改成每页 40"等于没改。实测 ps=40 返回 39 条。
        """
        params = {
            "media_id": int(media_id),
            "pn": max(1, int(pn)),
            "ps": max(1, min(self.PAGE_SIZE, int(ps))),
            "keyword": keyword,
            "order": order,
            "type": int(content_type),
            "tid": int(tid),
            "platform": "web",
        }
        data = self._request(
            "GET", f"{API_BASE}/x/v3/fav/resource/list", params=params
        )
        return data if isinstance(data, dict) else {}

    def fav_resource_ids(self, media_id: int) -> List[Dict[str, Any]]:
        """
        一次性取回收藏夹全部条目的 id 清单（轻量，不分页）。

        整理顺序时用来快速确认"服务端到底有多少条"，比逐页拉详情省得多。
        """
        data = self._request(
            "GET",
            f"{API_BASE}/x/v3/fav/resource/ids",
            params={"media_id": int(media_id), "platform": "web"},
        )
        return [x for x in (data or []) if isinstance(x, dict)] if isinstance(data, list) else []

    def fav_resource_keys(self, media_id: int, style: str = "bvid") -> List[str]:
        """
        一次性拿到收藏夹里全部条目的 key（轻量、不分页）。

        ⚠️ 只适合"**只关心有没有、不关心顺序**"的场合，比如预扫目标收藏夹。
        实测（945 条的收藏夹）：它会比逐页拉详情**多返回几条已失效、
        但仍占着 id 的条目**，条数和顺序都对不上 —— 拿它来重读线上顺序
        会把增量移动算歪。要顺序请用 fav_resource_all。

        style="bvid" → "BV1xx..." 或 "av123"（engine / state 那套 key）
        style="item" → "123:2"（sorter 那套 key）
        """
        out: List[str] = []
        for raw in self.fav_resource_ids(media_id):
            if not isinstance(raw, dict):
                continue
            aid = int(raw.get("id") or 0)
            if style == "item":
                if aid:
                    out.append(f"{aid}:{int(raw.get('type') or 2)}")
                continue
            bvid = str(raw.get("bv_id") or raw.get("bvid") or "").strip()
            if bvid:
                out.append(bvid)
            elif aid:
                out.append(f"av{aid}")
        return out

    # 实测：B 站这个接口接受 40（返回 39 条），不是文档写的 20。
    # 页数少一半，整夹读取就快一半。
    PAGE_SIZE = 40

    def fav_resource_all(
        self,
        media_id: int,
        order: str = "mtime",
        content_type: int = 0,
        on_page: Optional[Callable[[int, int], None]] = None,
        max_pages: int = 2000,
    ) -> List[Dict[str, Any]]:
        """
        把收藏夹内容完整拉下来（自动翻页）。

        on_page(页码, 累计条数) 用来给界面报进度。
        返回的是原始 medias 数组，顺序即服务端返回的顺序 —— 整理顺序时
        这个顺序必须原样当作"当前顺序"来用。
        """
        out: List[Dict[str, Any]] = []
        page = 1
        # 实测这个接口接受 ps=40（返回 39 条），不是文档上说的 20。
        # 页数直接砍一半：945 条的收藏夹从 48 页变成 25 页。
        while page <= max_pages:
            data = self.fav_resource_list(
                media_id, pn=page, ps=self.PAGE_SIZE, order=order, content_type=content_type
            )
            medias = data.get("medias") or []
            for raw in medias:
                if isinstance(raw, dict):
                    out.append(raw)
            if on_page is not None:
                on_page(page, len(out))
            if not medias or not data.get("has_more"):
                break
            page += 1
        return out

    def fav_resource_sort(self, media_id: int, sort: str) -> Any:
        """
        调整收藏夹内的条目顺序。

        注意：sort 传的是「移动操作序列」，不是完整列表 —— 这一点最容易搞错。
        单个操作的格式：  {参照条目id}:{参照类型}:{被移动条目id}:{被移动类型}
        含义是「把被移动的条目挪到参照条目的后面」；参照写成 0:0 表示挪到最前面。
        多个操作之间用逗号分隔，服务端按顺序依次执行。

        例： "456:2:123:2" 表示把 av123 移到 av456 后面。
        """
        return self._request(
            "POST",
            f"{API_BASE}/x/v3/fav/resource/sort",
            data={"media_id": int(media_id), "sort": sort},
            need_csrf=True,
        )

    def my_fav_folders(self, mid: int) -> List[Dict[str, Any]]:
        """我创建的全部收藏夹（含私密）。"""
        try:
            data = self._request(
                "GET",
                f"{API_BASE}/x/v3/fav/folder/created/list-all",
                params={"up_mid": int(mid)},
            )
            folders = (data or {}).get("list") if isinstance(data, dict) else None
            if folders:
                return list(folders)
        except BiliError:
            pass
        # 分页兜底
        out: List[Dict[str, Any]] = []
        pn = 1
        while pn <= 50:
            data = self._request(
                "GET",
                f"{API_BASE}/x/v3/fav/folder/created/list",
                params={"up_mid": int(mid), "pn": pn, "ps": 20},
            )
            folders = (data or {}).get("list") if isinstance(data, dict) else None
            if not folders:
                break
            out.extend(folders)
            if not (data or {}).get("has_more"):
                break
            pn += 1
        return out

    # ---------------- 收藏夹：写 ----------------
    def fav_deal(
        self,
        rid: int,
        add_media_ids: Sequence[int] = (),
        del_media_ids: Sequence[int] = (),
        content_type: int = TYPE_VIDEO,
    ) -> Any:
        """收藏 / 取消收藏**单个**条目到自己账号的收藏夹。"""
        data: Dict[str, Any] = {"rid": int(rid), "type": int(content_type)}
        if add_media_ids:
            data["add_media_ids"] = ",".join(str(int(x)) for x in add_media_ids)
        if del_media_ids:
            data["del_media_ids"] = ",".join(str(int(x)) for x in del_media_ids)
        return self._request(
            "POST", f"{API_BASE}/x/v3/fav/resource/deal", data=data, need_csrf=True
        )

    def fav_batch_deal(
        self,
        resources: Iterable[Tuple[int, int]],
        add_media_ids: Sequence[int] = (),
        del_media_ids: Sequence[int] = (),
    ) -> Any:
        """
        批量收藏 / 取消收藏。resources 为 (rid, type) 序列。

        注意：这是 B 站自己的批量接口，不同客户端表现不完全一致，
        调用方应当准备好回退到 fav_deal。
        """
        resources = list(resources)
        if not resources:
            return None
        data: Dict[str, Any] = {
            "resources": ",".join(f"{int(r)}:{int(t)}" for r, t in resources)
        }
        if add_media_ids:
            data["add_media_ids"] = ",".join(str(int(x)) for x in add_media_ids)
        if del_media_ids:
            data["del_media_ids"] = ",".join(str(int(x)) for x in del_media_ids)
        return self._request(
            "POST",
            f"{API_BASE}/x/v3/fav/resource/batch-deal",
            data=data,
            need_csrf=True,
        )

    def create_fav_folder(self, title: str, privacy: int = 0) -> Any:
        """新建收藏夹。privacy: 0 公开 / 1 私密。"""
        return self._request(
            "POST",
            f"{API_BASE}/x/v3/fav/folder/add",
            data={"title": title.strip(), "privacy": int(privacy)},
            need_csrf=True,
        )

    def delete_fav_folder(self, media_ids: Sequence[int]) -> Any:
        """
        删除收藏夹（可以一次删多个）。

        注意：删掉之后**里面的内容也一起没了**，而且不可恢复。
        想保内容就先 fav_move 到别的收藏夹，再删这个。
        """
        ids = [int(x) for x in media_ids if int(x or 0)]
        if not ids:
            return None
        return self._request(
            "POST",
            f"{API_BASE}/x/v3/fav/folder/del",
            data={"media_ids": ",".join(str(x) for x in ids)},
            need_csrf=True,
        )

    def fav_batch_copy(
        self,
        src_media_id: int,
        tar_media_id: int,
        mid: int,
        resources: Iterable[Tuple[int, int]],
    ) -> Any:
        """
        服务端批量复制（源收藏夹必须是自己账号下的）。

        注意：该接口的 src_media_id 要求是**自己的**收藏夹，因此不能用来
        搬别人收藏夹里的内容——搬别人的内容请走 fav_deal 逐条添加。
        这里提供它主要是为了"自己两个收藏夹之间合并"的场景。
        """
        resources = list(resources)
        if not resources:
            return None
        return self._request(
            "POST",
            f"{API_BASE}/x/v3/fav/resource/copy",
            data={
                "src_media_id": int(src_media_id),
                "tar_media_id": int(tar_media_id),
                "mid": int(mid),
                "resources": _pack_resources(resources),
                "platform": "web",
            },
            need_csrf=True,
        )

    def fav_batch_del(
        self, media_id: int, resources: Iterable[Tuple[int, int]]
    ) -> Any:
        """从指定收藏夹批量删除内容。resources 为 (avid, type) 序列。"""
        resources = list(resources)
        if not resources:
            return None
        return self._request(
            "POST",
            f"{API_BASE}/x/v3/fav/resource/batch-del",
            data={
                "media_id": int(media_id),
                "resources": _pack_resources(resources),
                "platform": "web",
            },
            need_csrf=True,
        )

    def fav_move(
        self, src_media_id: int, tar_media_id: int, mid: int, resources: Iterable[Tuple[int, int]]
    ) -> Any:
        """把自己账号下 A 收藏夹的内容移动到 B 收藏夹。"""
        resources = list(resources)
        if not resources:
            return None
        return self._request(
            "POST",
            f"{API_BASE}/x/v3/fav/resource/move",
            data={
                "src_media_id": int(src_media_id),
                "tar_media_id": int(tar_media_id),
                "mid": int(mid),
                "resources": _pack_resources(resources),
                "platform": "web",
            },
            need_csrf=True,
        )

    def fav_clean(self, media_id: int) -> Any:
        """一键清空收藏夹内所有已失效内容。"""
        return self._request(
            "POST",
            f"{API_BASE}/x/v3/fav/resource/clean",
            data={"media_id": int(media_id)},
            need_csrf=True,
        )

    def edit_fav_folder(
        self, media_id: int, title: str, intro: str = "", privacy: int = 0
    ) -> Any:
        """修改收藏夹标题 / 简介 / 公开性。"""
        return self._request(
            "POST",
            f"{API_BASE}/x/v3/fav/folder/edit",
            data={
                "media_id": int(media_id),
                "title": title.strip(),
                "intro": intro,
                "privacy": int(privacy),
            },
            need_csrf=True,
        )

    # ---------------- 视频信息 ----------------
    def video_detail(self, bvid: str = "", avid: int = 0) -> Dict[str, Any]:
        """
        查单个视频的信息（"添加视频"时用来确认这个号是什么、还在不在）。

        bvid 和 avid 二选一。查不到会抛 BiliError，由调用方转成人话提示。
        """
        params: Dict[str, Any] = {}
        if bvid:
            params["bvid"] = str(bvid).strip()
        elif avid:
            params["aid"] = int(avid)
        else:
            return {}
        data = self._request("GET", f"{API_BASE}/x/web-interface/view", params=params)
        return data if isinstance(data, dict) else {}

    def video_infos(self, bvids: Sequence[str]) -> List[Dict[str, Any]]:
        """
        ⚠️ 这个接口**用不了**，别再照它做"批量查视频"。

        曾经以为 `/x/web-interface/view?bvid=A,B,C` 能一次查 50 个，
        实测（真实账号、真实 BV 号）返回的是：

            {"code":-400,"message":"请求错误"}

        也就是 B 站现在**不支持逗号批量**。单个查是正常的（`video_detail`）。
        真要批量，只能一个一个来 —— 好在它是纯只读接口，可以把限速放宽。

        保留这个方法是为了让后来人看到这段注释，别再踩一次。
        """
        return []

    # ---------------- 稍后再看（顺手支持的搬运目标） ----------------
    def toview_list(self) -> List[Dict[str, Any]]:
        data = self._request("GET", f"{API_BASE}/x/v2/history/toview")
        if isinstance(data, dict):
            return list(data.get("list") or [])
        return []

    def toview_add(self, avid: int) -> Any:
        return self._request(
            "POST",
            f"{API_BASE}/x/v2/history/toview/add",
            data={"aid": int(avid)},
            need_csrf=True,
        )

    # ---------------- 扫码登录 ----------------
    def qr_generate(self) -> Dict[str, Any]:
        """取登录二维码。返回 {url, qrcode_key}，url 需要自己渲染成二维码图片。"""
        data = self._request(
            "GET", f"{PASSPORT_BASE}/x/passport-login/web/qrcode/generate"
        )
        return data if isinstance(data, dict) else {}

    def qr_poll(self, qrcode_key: str) -> Dict[str, Any]:
        """
        轮询扫码状态。

        data.code: 0 成功 / 86038 二维码失效 / 86090 已扫码待确认 / 86101 未扫码
        扫码成功后 Cookie 会自动进入 self.s。
        """
        data = self._request(
            "GET",
            f"{PASSPORT_BASE}/x/passport-login/web/qrcode/poll",
            params={"qrcode_key": qrcode_key},
            retries=2,
        )
        return data if isinstance(data, dict) else {}

    # ---------------- Cookie 导入 ----------------
    def load_cookies(self, raw: str) -> Tuple[bool, str]:
        """
        从用户粘贴的文本里解析并载入 Cookie。

        接受 "a=1; b=2" 形式的整段 Cookie 字符串，或每行 "名字=值"。
        返回 (是否成功, 提示信息)。
        """
        pairs: Dict[str, str] = {}
        text = (raw or "").replace("\r", "\n")
        for chunk in text.replace("\n", ";").split(";"):
            chunk = chunk.strip()
            if not chunk or "=" not in chunk:
                continue
            key, _, value = chunk.partition("=")
            key, value = key.strip(), value.strip().strip('"')
            if key and value:
                pairs[key] = value

        if not pairs.get("SESSDATA"):
            return False, "没找到 SESSDATA。请在浏览器开发者工具的 Application → Cookies 里复制 SESSDATA 的值。"
        if not pairs.get("bili_jct"):
            return False, "没找到 bili_jct。写操作需要它作为 csrf token，请一并复制。"

        for name in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"):
            if pairs.get(name):
                self.s.cookies.set(name, pairs[name], domain=".bilibili.com")
        self._wbi_keys = None
        return True, "Cookie 已载入"

    def clear_login(self) -> None:
        self.s.cookies.clear()
        self._bootstrapped = False
        self._wbi_keys = None
