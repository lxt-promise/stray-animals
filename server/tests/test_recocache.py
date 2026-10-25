# -*- coding: utf-8 -*-
"""识别结果缓存的回归测试。

守的是 2026-10-25 那个现场：一段 6 秒视频在 1 分钟内被算了 **10 次**，
每次 3.5s，最后一次都没用上 —— 云函数 poll 路径只能给 AI 1.8s，
窗口注定算不完，于是每轮从头再算、结果全丢，重试耗尽后降级本地引擎，
前端显示「识别服务暂时不可用」。

缓存要解决的不是「算得快」，而是「第二次调用能拿到第一次的结果」。
所以下面每一条都围着这个语义：谁算、谁等、等不到怎么办、什么不该缓存。
"""
from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import recocache  # noqa: E402


class TestCacheBasics(unittest.TestCase):
    def setUp(self):
        recocache.reset()

    def tearDown(self):
        recocache.reset()

    def test_second_call_hits_cache(self):
        """同一素材第二次调用不再计算 —— 这是整个模块存在的理由。"""
        calls = []

        def compute():
            calls.append(1)
            return {"v": len(calls)}

        a, cached_a = recocache.get_or_compute("k", 600, 64, compute)
        b, cached_b = recocache.get_or_compute("k", 600, 64, compute)
        self.assertEqual(a["v"], 1)
        self.assertFalse(cached_a, "第一次应是自己算的")
        self.assertEqual(b["v"], 1, "第二次必须拿到第一次的结果，而不是重算")
        self.assertTrue(cached_b)
        self.assertEqual(len(calls), 1)

    def test_different_keys_not_shared(self):
        """不同素材互不干扰（学校不同 → 档案库不同 → 候选也不同）。"""
        recocache.get_or_compute("k1", 600, 64, lambda: {"v": 1})
        r, cached = recocache.get_or_compute("k2", 600, 64, lambda: {"v": 2})
        self.assertEqual(r["v"], 2)
        self.assertFalse(cached)
        # key 里带 schoolId：同一张图在两校的结果必须分开
        k_a = recocache.cache_key("image", "http://x/a.jpg", "", 1, "school_A")
        k_b = recocache.cache_key("image", "http://x/a.jpg", "", 1, "school_B")
        self.assertNotEqual(k_a, k_b)

    def test_expired_entry_recomputed(self):
        """过期后重新算，不能拿 10 分钟前的老结果糊弄。"""
        self.assertEqual(recocache.get_or_compute("k", 0.05, 64, lambda: {"v": 1})[0]["v"], 1)
        time.sleep(0.08)
        r, cached = recocache.get_or_compute("k", 0.05, 64, lambda: {"v": 2})
        self.assertEqual(r["v"], 2)
        self.assertFalse(cached)

    def test_capacity_evicts_oldest(self):
        """容量上限生效：不能让缓存无限涨（容器内存有配额）。"""
        for i in range(5):
            recocache.get_or_compute("k%d" % i, 600, 3, lambda i=i: {"v": i})
        self.assertLessEqual(recocache.size(), 3)

    def test_cache_disabled_by_zero_ttl(self):
        """TTL=0 表示关闭缓存（由 config 层判断，这里确认 key 计算不炸）。"""
        self.assertTrue(recocache.cache_key("image", "", "", 1, ""))


class TestWaitForInFlight(unittest.TestCase):
    """「别人正在算时怎么办」—— 这条决定视频能不能收敛。"""

    def setUp(self):
        recocache.reset()

    def tearDown(self):
        recocache.reset()

    def test_waiter_gets_others_result(self):
        """后来者排队等到第一次的结果，而不是自己再算一遍。

        没有这条，poll#1 还在算的时候 poll#2 又开一遍 —— 两倍 CPU，
        且两个请求都在 1.8s 窗口内超时，永远收敛不了。
        """
        started = threading.Event()
        release = threading.Event()
        out = {}
        waited = {}

        def slow():
            started.set()
            release.wait(5)          # 模拟「视频识别 3.5s」这种慢活
            return {"v": "first"}

        def owner():
            out["o"] = recocache.get_or_compute("k", 600, 64, slow)

        def waiter():
            # 后来者排队等；它的 compute 不应该被调用
            waited["r"] = recocache.get_or_compute(
                "k", 600, 64, lambda: {"v": "second"}, wait_ms=4000)

        t = threading.Thread(target=owner)
        t.start()
        self.assertTrue(started.wait(2), "计算线程没起来")

        tw = threading.Thread(target=waiter)
        tw.start()
        time.sleep(0.2)              # 让等待者进入排队
        release.set()                # 第一次计算完成
        t.join(5)
        tw.join(5)

        r, cached = waited["r"]
        self.assertIsNotNone(r, "等待者应拿到结果，而不是 None")
        self.assertEqual(r["v"], "first", "后来者必须拿到第一次算出的结果，不是自己重算")
        self.assertTrue(cached)
        self.assertEqual(out["o"][0]["v"], "first")

    def test_waiter_gives_up_when_impatient(self):
        """排队超时返回 (None, False)：让调用方按自己节奏重试，不阻塞不报错。"""
        started = threading.Event()
        release = threading.Event()

        def slow():
            started.set()
            release.wait(5)
            return {"v": "first"}

        t = threading.Thread(target=lambda: recocache.get_or_compute("k", 600, 64, slow))
        t.start()
        self.assertTrue(started.wait(2))

        r, cached = recocache.get_or_compute("k", 600, 64, lambda: {"v": "second"}, wait_ms=50)
        release.set()
        t.join(5)

        self.assertIsNone(r, "耐心耗尽应返回 None，由调用方重试")
        self.assertFalse(cached)

    def test_wait_zero_returns_immediately(self):
        """waitMs=0 表示不等（老调用方/同步路径），立刻返回让上层处理。"""
        started = threading.Event()
        release = threading.Event()

        def slow():
            started.set()
            release.wait(5)
            return {"v": "first"}

        t = threading.Thread(target=lambda: recocache.get_or_compute("k", 600, 64, slow))
        t.start()
        self.assertTrue(started.wait(2))
        t0 = time.time()
        r, cached = recocache.get_or_compute("k", 600, 64, lambda: {"v": "second"}, wait_ms=0)
        cost = time.time() - t0
        release.set()
        t.join(5)
        self.assertIsNone(r)
        self.assertLess(cost, 1.0, "waitMs=0 不该阻塞")

    def test_only_one_compute_under_concurrency(self):
        """并发 8 个请求，实际只算一次 —— CPU 不被放大 8 倍。"""
        calls = []
        barrier = threading.Barrier(8)
        results = [None] * 8

        def work(i):
            def compute():
                calls.append(1)
                time.sleep(0.15)
                return {"v": "shared"}
            barrier.wait(timeout=5)
            results[i] = recocache.get_or_compute("k", 600, 64, compute, wait_ms=3000)

        threads = [threading.Thread(target=work, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)

        self.assertEqual(len(calls), 1, "并发下只能有一次真实计算，实际 %d 次" % len(calls))
        for r in results:
            self.assertEqual(r[0]["v"], "shared")


class TestFailureHandling(unittest.TestCase):
    def setUp(self):
        recocache.reset()

    def tearDown(self):
        recocache.reset()

    def test_failure_not_cached(self):
        """失败不缓存：一次网络抖动不能被记住整个 TTL 周期。"""
        attempts = []

        def boom():
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("素材下载失败")
            return {"v": "ok"}

        with self.assertRaises(RuntimeError):
            recocache.get_or_compute("k", 600, 64, boom)
        r, cached = recocache.get_or_compute("k", 600, 64, boom)
        self.assertEqual(r["v"], "ok")
        self.assertFalse(cached, "失败后应重新计算，而不是读到一个不存在的缓存")
        self.assertEqual(len(attempts), 2)

    def test_waiter_after_failure_not_hung(self):
        """计算者抛错后，等待者不能被永久挂住。"""
        started = threading.Event()
        release = threading.Event()

        def boom():
            started.set()
            release.wait(3)
            raise RuntimeError("boom")

        t = threading.Thread(target=lambda: self._swallow(boom))
        t.start()
        self.assertTrue(started.wait(2))
        r, cached = recocache.get_or_compute("k", 600, 64, lambda: {"v": "x"}, wait_ms=300)
        release.set()
        t.join(5)
        # 计算者失败 → 记录被删 → 等待者拿不到结果，返回 None 由调用方重试
        self.assertIsNone(r)
        self.assertFalse(cached)
        self.assertEqual(recocache.size(), 0, "失败的条目必须被清掉")

    def _swallow(self, fn):
        try:
            recocache.get_or_compute("k", 600, 64, fn)
        except Exception:  # noqa: BLE001
            pass


class TestStats(unittest.TestCase):
    def setUp(self):
        recocache.reset()

    def tearDown(self):
        recocache.reset()

    def test_stats_reflects_inflight(self):
        """/health 要能看出「有几条在算」—— 排查重复识别时的第一手证据。"""
        self.assertEqual(recocache.stats(), {"cached": 0, "computing": 0})
        started = threading.Event()
        release = threading.Event()
        t = threading.Thread(target=lambda: recocache.get_or_compute(
            "k", 600, 64, lambda: (started.set(), release.wait(5), {"v": 1})[2]))
        t.start()
        self.assertTrue(started.wait(2))
        st = recocache.stats()
        self.assertEqual(st["computing"], 1)
        release.set()
        t.join(5)
        self.assertEqual(recocache.stats()["computing"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
