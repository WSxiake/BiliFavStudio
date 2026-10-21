# -*- coding: utf-8 -*-
"""
自测脚本：验证核心算法与模块健康度。

重点验证 sorter.build_move_ops —— 它决定了"顺序整理"到底能不能排对。
验证方式是把生成的操作序列丢给一个"模拟 B 站服务端"，看执行完之后
顺序是不是真的变成了用户想要的样子。随机跑几千轮。
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# 中文控制台是 GBK，遇到编不出来的字符降级而不是崩
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

from bilifav.sorter import FRONT, build_move_ops, normalize_item, pack_ops


def simulate_server(original, ops):
    """模拟服务端按顺序执行移动操作。"""
    cur = list(original)
    for before, moved in ops:
        if moved not in cur:
            raise AssertionError(f"要移动的条目不在列表里：{moved}")
        cur.remove(moved)
        if before is None:
            cur.insert(0, moved)
        else:
            if before not in cur:
                raise AssertionError(f"参照条目不在列表里：{before}")
            index = cur.index(before)
            cur.insert(index + 1, moved)
    return cur


def test_identity():
    items = [f"a{i}:2" for i in range(10)]
    ops = build_move_ops(items, items)
    assert ops == [], f"顺序没变却生成了操作：{ops}"
    print("  [OK] 顺序相同时不产生任何操作")


def test_reverse():
    items = [f"a{i}:2" for i in range(8)]
    target = list(reversed(items))
    ops = build_move_ops(items, target)
    got = simulate_server(items, ops)
    assert got == target, f"反转失败：\n  期望 {target}\n  实际 {got}"
    print(f"  [OK] 整体反转：{len(items)} 条 → {len(ops)} 次移动，结果正确")


def test_move_to_front():
    items = ["a:2", "b:2", "c:2", "d:2"]
    target = ["d:2", "a:2", "b:2", "c:2"]
    ops = build_move_ops(items, target)
    got = simulate_server(items, ops)
    assert got == target, f"移到最前失败：{got}"
    assert ops[0][0] is None, f"移到最前应该用 None 参照，实际 {ops[0]}"
    packed = pack_ops(ops)
    assert packed.startswith(FRONT), f"打包后应该以 0:0 开头：{packed}"
    print(f"  [OK] 移到最前：{packed}")


def test_random_fuzz(rounds: int = 3000):
    rng = random.Random(20261016)
    worst = 0
    for round_no in range(rounds):
        size = rng.randint(1, 60)
        items = [f"x{i}:2" for i in range(size)]
        target = items[:]
        rng.shuffle(target)
        ops = build_move_ops(items, target)
        got = simulate_server(items, ops)
        if got != target:
            print(f"  [FAIL] 第 {round_no} 轮失败")
            print(f"    原始 {items}")
            print(f"    目标 {target}")
            print(f"    操作 {ops}")
            print(f"    实际 {got}")
            return False
        worst = max(worst, len(ops))
    print(f"  [OK] 随机 {rounds} 轮全部通过（最多用到 {worst} 次移动）")
    return True


def test_partial():
    """只挪动其中几条的情况，操作数应该很少。"""
    items = [f"y{i}:2" for i in range(20)]
    target = items[:]
    item = target.pop(15)
    target.insert(2, item)
    ops = build_move_ops(items, target)
    got = simulate_server(items, ops)
    assert got == target
    assert len(ops) == 1, f"只挪一条却用了 {len(ops)} 次操作"
    print(f"  [OK] 只挪一条 → 只用 1 次操作：{pack_ops(ops)}")


def test_duplicate_keys_guard():
    """目标里混进了源里没有的条目时，不应该炸。"""
    items = ["a:2", "b:2"]
    target = ["b:2", "ghost:2", "a:2"]
    ops = build_move_ops(items, target)
    got = simulate_server(items, ops)
    assert "ghost:2" not in got
    print(f"  [OK] 遇到不存在的条目会跳过，不炸（结果 {got}）")


def test_normalize():
    raw = {
        "id": 12345, "type": 2, "bvid": "BV1xx411c7mD", "title": "测试视频",
        "upper": {"mid": 1, "name": "某个UP"},
        "duration": 3661, "pubtime": 1700000000, "fav_time": 1700000100,
        "attr": 0, "cover": "http://i0.hdslb.com/x.jpg",
        "cnt_info": {"play": 123456, "danmaku": 789, "collect": 456},
    }
    it = normalize_item(raw)
    assert it["key"] == "12345:2"
    # 拼音键用空格分隔音节（避免 "xi'an" 和 "xian" 混在一起），比较时去掉空格
    assert it["py"].replace(" ", "") == "ceshishipin", it["py"]
    assert it["py_upper"].replace(" ", "") == "mougeup", it["py_upper"]
    assert it["invalid"] is False
    assert it["play"] == 123456

    dead = normalize_item({"id": 1, "type": 2, "title": "已失效视频", "attr": 9})
    assert dead["invalid"] is True, "attr=9 应该判定为失效"
    broken = normalize_item({"id": 2, "type": 2, "title": "正常", "attr": 1})
    assert broken["invalid"] is True, "attr=1 应该判定为失效"
    print("  [OK] 条目归一化正确（含失效判定与拼音键）")


def test_pinyin():
    from bilifav.pinyin import sort_key, stats
    words = ["百度", "阿里", "腾讯", "中国", "走起", "啊呀"]
    ordered = sorted(words, key=sort_key)
    expect = ["阿里", "啊呀", "百度", "腾讯", "中国", "走起"]
    assert ordered == expect, f"拼音排序不对：{ordered}"
    st = stats()
    assert st["chars"] > 20000, f"拼音表太小：{st}"
    print(f"  [OK] 拼音排序正确（覆盖 {st['chars']} 字，{st['bytes'] / 1024:.0f} KB）")


def test_media_id_parser():
    from bilifav.util import parse_media_id
    cases = [
        ("https://space.bilibili.com/123/favlist?fid=456789&ftype=create", 456789),
        ("https://www.bilibili.com/medialist/detail/ml1052622027", 1052622027),
        ("1052622027", 1052622027),
        ("ml1052622027", 1052622027),
    ]
    for raw, want in cases:
        got = parse_media_id(raw)
        assert got == want, f"{raw} → {got}，期望 {want}"
    print("  [OK] 收藏夹 ID 解析正确")


# --------------------------------------------------------------------------
# 复制引擎：用假客户端把整条链路跑一遍
# --------------------------------------------------------------------------
def _make_media(index: int, invalid: bool = False, title: str = "") -> dict:
    return {
        "id": 100000 + index,
        "type": 2,
        "bvid": f"BV1{index:09d}",
        "title": title or f"测试视频 {index}" + ("（已失效）" if invalid else ""),
        "upper": {"mid": 9, "name": "某个UP"},
        "attr": 1 if invalid else 0,
        "duration": 60 + index,
        "pubtime": 1700000000 + index,
        "fav_time": 1700000000 + index,
        "cnt_info": {"play": index * 100, "danmaku": index, "collect": index * 2},
    }


class FakeClient:
    """假装自己是 BiliClient，按剧本回应，顺便把调用都记下来。"""

    def __init__(self, source, target, fail_at=None, batch_ok=False,
                 fail_code=-10003, fail_msg="稿件不可用"):
        self.source = source
        self.target = target
        self.fail_at = fail_at or set()
        self.batch_ok = batch_ok
        self.fail_code = fail_code
        self.fail_msg = fail_msg
        self.cancel = None
        self.csrf = "fake_csrf"
        self.added = []
        self.sort_payloads = []
        self.deal_calls = 0
        self.list_calls = 0

    # --- 引擎用到的接口 ---
    def set_cancel(self, event):
        self.cancel = event

    def set_delay(self, delay, jitter=None):
        pass

    def log(self, msg, level="info"):
        pass

    def faster(self, delay=0.35):
        """真客户端用它是为了临时调松限速；测试里不需要等，直接放行。"""
        import contextlib
        return contextlib.nullcontext()

    def fav_resource_keys(self, media_id, style="bvid"):
        """轻量接口：一次拿到收藏夹里所有条目的 key。"""
        pool = self.source if media_id == 1 else self.target
        out = []
        for raw in pool:
            aid = int(raw.get("id") or 0)
            if style == "item":
                if aid:
                    out.append(f"{aid}:{int(raw.get('type') or 2)}")
                continue
            bvid = str(raw.get("bvid") or "").strip()
            out.append(bvid or f"av{aid}")
        return out

    def fav_resource_list(self, media_id, pn=1, ps=20, order="mtime", content_type=0):
        self.list_calls += 1
        pool = self.source if media_id == 1 else self.target
        chunk = pool[(pn - 1) * ps: pn * ps]
        data = {
            "medias": chunk,
            "has_more": pn * ps < len(pool),
            "info": {"media_count": len(pool)},
        }
        return data

    def fav_deal(self, rid, add_media_ids=(), content_type=2):
        from bilifav.api import BiliError
        self.deal_calls += 1
        if self.deal_calls in self.fail_at:
            raise BiliError(self.fail_code, self.fail_msg)
        self.added.append(rid)
        return None

    def fav_batch_deal(self, resources, add_media_ids=(), del_media_ids=()):
        from bilifav.api import BiliError
        if not self.batch_ok:
            raise BiliError(-400, "批量接口不可用")
        self.added.extend(r for r, _ in resources)
        return None

    def fav_resource_sort(self, media_id, sort):
        self.sort_payloads.append(sort)
        return None


def test_engine_full_run():
    """完整跑一遍：25 条源（3 条失效）→ 目标已有 5 条，验证分类计数。

    注意失效的条目要避开目标已有的那 5 条：预扫会把"目标里已经有了"的
    先标记成重复，之后就不再单独统计它是否失效了。
    """
    import tempfile
    from pathlib import Path

    from bilifav.engine import CopyEngine, CopyOptions
    from bilifav.state import CopyState

    source = [_make_media(i, invalid=(i in (7, 13, 19))) for i in range(25)]
    target = [_make_media(i) for i in range(5)]        # 前 5 条目标里已经有了
    client = FakeClient(source, target)

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "state.json"
        state = CopyState.new(
            path,
            {"media_id": 1, "title": "源收藏夹"},
            {"media_id": 2, "title": "目标收藏夹"},
            12345,
        )
        events = []
        engine = CopyEngine(
            client, state, 
            CopyOptions(delay=0, jitter=0, batch_size=1, prescan_target=True, save_every=1),
            emit=events.append,
        )
        reason = engine.run()

        assert reason == "finished", f"应该正常跑完，实际 {reason}"
        summary = state.summary()
        assert summary["total"] == 25, summary
        assert summary["invalid"] == 3, f"失效条数不对：{summary}"
        assert summary["duplicate"] == 5, f"重复条数不对：{summary}"
        assert summary["done"] == 17, f"新增条数不对：{summary}"
        assert summary["remaining"] == 0, f"应该没有剩余：{summary}"
        assert len(client.added) == 17, f"实际添加了 {len(client.added)} 条"

        # 断点续传：再跑一次应该什么都不做
        before = client.deal_calls
        engine2 = CopyEngine(client, state, CopyOptions(delay=0, jitter=0, batch_size=1), emit=events.append)
        assert engine2.run() == "finished"
        assert client.deal_calls == before, "第二次跑不应该再发添加请求"

    print(f"  [OK] 完整流程：25 条源 → 新增 17 / 重复 5 / 失效跳过 3，一个不差")
    print("  [OK] 重复运行不会重复添加（断点续传生效）")


def test_engine_resume_after_stop():
    """跑到一半停掉，再起来应该正好从断点继续。"""
    import tempfile
    import threading
    from pathlib import Path

    from bilifav.engine import CopyEngine, CopyOptions
    from bilifav.state import CopyState

    source = [_make_media(i) for i in range(20)]
    client = FakeClient(source, [])

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "state.json"
        state = CopyState.new(
            path, {"media_id": 1, "title": "源"}, {"media_id": 2, "title": "目标"}, 1
        )

        # 添加够 8 条就自动喊停
        original_deal = client.fav_deal

        def deal_and_stop(rid, add_media_ids=(), content_type=2):
            result = original_deal(rid, add_media_ids, content_type)
            if len(client.added) >= 8:
                engine.stop()
            return result

        client.fav_deal = deal_and_stop
        engine = CopyEngine(client, state, CopyOptions(delay=0, jitter=0, batch_size=1), emit=lambda e: None)
        reason = engine.run()
        assert reason == "cancelled", f"应该被中止，实际 {reason}"
        first_round = state.summary()
        assert 0 < first_round["done"] < 20, f"中止时应该完成了一部分：{first_round}"

        # 状态文件应该已经落盘
        reloaded = CopyState.load(path)
        assert reloaded.summary()["done"] == first_round["done"], "进度没存下来"

        # 重新起一个引擎接着跑
        client.fav_deal = original_deal
        engine2 = CopyEngine(client, reloaded, CopyOptions(delay=0, jitter=0, batch_size=1), emit=lambda e: None)
        assert engine2.run() == "finished"
        final = reloaded.summary()
        assert final["done"] == 20, f"续跑之后应该全部完成：{final}"
        assert final["remaining"] == 0

    print(f"  [OK] 中止时完成 {first_round['done']} 条，重开后补完剩余，最终 20/20")


def test_engine_batch_fallback():
    """批量接口不可用时应自动退回逐条，而不是整个失败。"""
    import tempfile
    from pathlib import Path

    from bilifav.engine import CopyEngine, CopyOptions
    from bilifav.state import CopyState

    source = [_make_media(i) for i in range(10)]
    client = FakeClient(source, [], batch_ok=False)

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "state.json"
        state = CopyState.new(path, {"media_id": 1, "title": "s"}, {"media_id": 2, "title": "t"}, 1)
        engine = CopyEngine(
            client, state,
            CopyOptions(delay=0, jitter=0, batch_size=5),   # 故意开批量
            emit=lambda e: None,
        )
        assert engine.run() == "finished"
        assert state.summary()["done"] == 10, state.summary()

    print("  [OK] 批量接口不可用时自动退回逐条（10/10 完成）")


def test_engine_circuit_breaker():
    """连续失败达到阈值要熔断，别把账号搭进去。"""
    import tempfile
    from pathlib import Path

    from bilifav.engine import CopyEngine, CopyOptions
    from bilifav.state import CopyState

    source = [_make_media(i) for i in range(30)]
    # 用一个"未知错误"码，它既不是"稿件失效"也不是"重复收藏"，会被算作真失败
    client = FakeClient(source, [], fail_at=set(range(1, 31)),
                        fail_code=99999, fail_msg="未知的接口错误")

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "state.json"
        state = CopyState.new(path, {"media_id": 1, "title": "s"}, {"media_id": 2, "title": "t"}, 1)
        engine = CopyEngine(
            client, state,
            CopyOptions(delay=0, jitter=0, batch_size=1, max_consecutive_failures=5,
                        skip_invalid=False),
            emit=lambda e: None,
        )
        reason = engine.run()
        assert reason == "stopped", f"连续失败应该熔断，实际 {reason}"
        assert client.deal_calls == 5, f"应该在 5 次连续失败后停手，实际试了 {client.deal_calls} 次"

    print(f"  [OK] 连续失败 5 次后自动熔断（只试了 {client.deal_calls} 次就收手了）")


def test_sort_applier():
    """顺序提交：验证分批、载荷格式、以及中止后不继续。"""
    import tempfile
    from pathlib import Path

    from bilifav.sorter import SortApplier

    client = FakeClient([], [])
    original = [f"{i}:2" for i in range(50)]
    target = list(reversed(original))          # 反转 → 需要 49 次移动

    events = []
    applier = SortApplier(client, events.append, batch_size=20)
    result = applier.run(3600, original, target)

    assert result["ok"] is True, result
    assert result["ops"] == 49, f"移动次数应为 49，实际 {result['ops']}"
    assert len(client.sort_payloads) == 3, f"应该分 3 批，实际 {len(client.sort_payloads)}"

    # 每一批的载荷都应该是 "参照:类型:被移动:类型" 的形式
    # 参照为 0:0 时表示"移到最前面"，此时参照的类型位就是 0
    all_ops = []
    for payload in client.sort_payloads:
        for piece in payload.split(","):
            parts = piece.split(":")
            assert len(parts) == 4, f"载荷格式不对：{piece}"
            b_id, b_type, m_id, m_type = parts
            assert m_type in ("2", "12", "21"), f"被移动项类型不对：{piece}"
            assert b_id == "0" or b_type in ("2", "12", "21"), f"参照项类型不对：{piece}"
            all_ops.append((None if b_id == "0" else f"{b_id}:{b_type}", f"{m_id}:{m_type}"))

    # 把三批拼起来模拟服务端执行，最终顺序应该正好是目标顺序
    got = simulate_server(original, all_ops)
    assert got == target, "分批提交后的最终顺序不对"

    # 顺序没变化时不应发请求
    client.sort_payloads.clear()
    applier2 = SortApplier(client, events.append)
    r2 = applier2.run(3600, original, original)
    assert r2["reason"] == "noop" and not client.sort_payloads, r2

    # 目标里少了条目 → 拒绝提交（说明加载之后收藏夹被人改过）
    r3 = applier2.run(3600, original, original[:10])
    assert r3["ok"] is False and r3["reason"] == "mismatch", r3

    print("  [OK] 顺序提交：49 次移动分 3 批，拼起来模拟执行后顺序完全正确")
    print("  [OK] 顺序未变时不发请求；目标列表不完整时拒绝提交")


# --------------------------------------------------------------------------
# 增删 + 排序：用一个"会真的记住改动"的假服务端跑全流程
# --------------------------------------------------------------------------
class FakeLiveClient:
    """
    一个会真正维护收藏夹内容的假客户端。

    删除会真的删、添加会真的插到最前面、排序会真的按操作序列重排 ——
    这样就能端到端验证「先删 → 再加 → 重读 → 排序」这条链路到底对不对。
    """

    def __init__(self, live, fail_add=None):
        self.folder_items = [dict(it) for it in live]
        self.fail_add = set(fail_add or ())
        self.csrf = "fake_csrf"
        self.cancel = None
        self.del_calls = []
        self.add_calls = []
        self.sort_calls = []

    # --- 引擎/提交器用到的接口 ---
    def set_cancel(self, event):
        self.cancel = event

    def set_delay(self, delay, jitter=None):
        pass

    def log(self, msg, level="info"):
        pass

    def faster(self, delay=0.35):
        import contextlib
        return contextlib.nullcontext()

    def fav_resource_keys(self, media_id, style="bvid"):
        """轻量接口：一次拿到收藏夹里所有条目的 key（顺序同当前内容）。"""
        out = []
        for it in self.folder_items:
            aid = int(it.get("id") or 0)
            if style == "item":
                if aid:
                    out.append(f"{aid}:{int(it.get('type') or 2)}")
                continue
            bvid = str(it.get("bvid") or "").strip()
            out.append(bvid or f"av{aid}")
        return out

    def fav_resource_all(self, media_id, order="mtime", content_type=0,
                         on_page=None, max_pages=2000):
        if on_page:
            on_page(1, len(self.folder_items))
        return [dict(it) for it in self.folder_items]

    def fav_batch_del(self, media_id, resources):
        self.del_calls.append(list(resources))
        drop = {f"{r}:{t}" for r, t in resources}
        self.folder_items = [
            it for it in self.folder_items if f"{it['id']}:{it['type']}" not in drop
        ]
        return None

    def fav_deal(self, rid, add_media_ids=(), del_media_ids=(), content_type=2):
        from bilifav.api import BiliError
        self.add_calls.append(rid)
        if rid in self.fail_add:
            raise BiliError(-10003, "稿件不可用")
        # B 站的实际行为：新收藏会插在最前面
        self.folder_items.insert(
            0, {"id": rid, "type": content_type, "bvid": "", "title": f"新加的{rid}"}
        )
        return None

    def fav_resource_sort(self, media_id, sort):
        self.sort_calls.append(sort)
        ops = []
        for piece in sort.split(","):
            b_id, b_type, m_id, m_type = piece.split(":")
            ops.append((None if b_id == "0" else f"{b_id}:{b_type}", f"{m_id}:{m_type}"))
        before = [f"{it['id']}:{it['type']}" for it in self.folder_items]
        after = simulate_server(before, ops)
        by_key = {f"{it['id']}:{it['type']}": it for it in self.folder_items}
        self.folder_items = [by_key[k] for k in after]
        return None

    def keys(self):
        return [f"{it['id']}:{it['type']}" for it in self.folder_items]


def test_sort_delete_and_add():
    """一次提交里同时删除、添加、重排，最终线上顺序必须跟界面上看到的一致。"""
    from bilifav.sorter import SortApplier

    live = [{"id": 100 + i, "type": 2, "bvid": f"BV{i:010d}", "title": f"老视频{i}"}
            for i in range(10)]
    client = FakeLiveClient(live)

    original = [f"{100 + i}:2" for i in range(10)]
    deletions = [original[2], original[5]]          # 删掉第 3、第 6 条
    additions = [
        {"key": "900:2", "avid": 900, "type": 2, "bvid": "BVnew00001", "title": "新视频A"},
        {"key": "901:2", "avid": 901, "type": 2, "bvid": "BVnew00002", "title": "新视频B"},
    ]
    kept = [k for k in original if k not in deletions]
    target = list(reversed(kept + ["900:2", "901:2"]))   # 故意排成完全反过来的顺序

    events = []
    applier = SortApplier(client, events.append, batch_size=50)
    result = applier.run(3600, original, target, deletions, additions)

    assert result["ok"] is True, result
    got = client.keys()
    assert got == target, f"最终顺序不对\n  期望 {target}\n  实际 {got}"
    assert len(client.del_calls) == 1 and len(client.del_calls[0]) == 2, client.del_calls
    assert sorted(client.add_calls) == [900, 901], client.add_calls

    print("  [OK] 删除 2 条 + 添加 2 条 + 整体重排，线上最终顺序与界面完全一致")
    print(f"       删除批次 {len(client.del_calls)}，添加 {len(client.add_calls)} 条，"
          f"排序请求 {len(client.sort_calls)} 次")


def test_sort_add_failure_tolerated():
    """某个视频加不进去（比如已失效）时，其余改动要照常完成，不能整个崩掉。"""
    from bilifav.sorter import SortApplier

    live = [{"id": 200 + i, "type": 2, "bvid": f"BV{i:010d}", "title": f"视频{i}"}
            for i in range(5)]
    client = FakeLiveClient(live, fail_add={901})       # 901 会加失败

    original = [f"{200 + i}:2" for i in range(5)]
    additions = [
        {"key": "900:2", "avid": 900, "type": 2, "bvid": "BVok", "title": "能加进去的"},
        {"key": "901:2", "avid": 901, "type": 2, "bvid": "BVdead", "title": "加不进去的"},
    ]
    # 界面上两条都当作"要添加"，其中 901 会被服务端拒绝
    target = ["900:2", "901:2"] + original

    events = []
    applier = SortApplier(client, events.append, batch_size=50)
    result = applier.run(3600, original, target, [], additions)

    assert result["ok"] is True, result
    got = client.keys()
    assert got[0] == "900:2", f"能加进来的那条应该排到最前面，实际 {got}"
    assert "901:2" not in got, "加失败的那条不该出现在线上"
    assert result.get("notes"), "应该给出提示说明有东西被排除了"

    print("  [OK] 有一条加不进去时，其余改动照常完成，并给出提示")
    print(f"       提示：{result['notes'][0]}")


def main() -> int:
    print("=" * 62)
    print("BiliFav Studio 自测")
    print("=" * 62)

    suites = [
        ("顺序推导算法", [test_identity, test_reverse, test_move_to_front,
                          test_partial, test_duplicate_keys_guard]),
        ("随机压力测试", [test_random_fuzz]),
        ("复制引擎（模拟端到端）", [test_engine_full_run, test_engine_resume_after_stop,
                                   test_engine_batch_fallback, test_engine_circuit_breaker]),
        ("顺序提交（模拟端到端）", [test_sort_applier]),
        ("增删条目（模拟端到端）", [test_sort_delete_and_add, test_sort_add_failure_tolerated]),
        ("数据归一化", [test_normalize]),
        ("中文拼音排序", [test_pinyin]),
        ("工具函数", [test_media_id_parser]),
    ]
    failed = 0
    for name, funcs in suites:
        print(f"\n[{name}]")
        for func in funcs:
            try:
                func()
            except AssertionError as exc:
                print(f"  [FAIL] {func.__name__}: {exc}")
                failed += 1
            except Exception as exc:  # noqa: BLE001
                print(f"  [FAIL] {func.__name__} 抛异常: {type(exc).__name__}: {exc}")
                failed += 1

    print("\n" + "=" * 62)
    if failed:
        print(f"{failed} 项没过")
        return 1
    print("全部通过，本鲸的算法没毛病～")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
