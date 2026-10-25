"""识别结果缓存 —— 让「同一个素材被反复识别」只算一次。

## 为什么要这个模块

线上日志（2026-10-25）里，一段 6 秒的**同一个视频**在一分钟内被请求了 **10 次**，
每次服务端都完整重跑一遍：下载视频 → ffmpeg 抽 3 帧 → 检测 → 逐帧推理 ≈ 3.5s。

根因是两条时间线对不上：

    云函数 poll 路径的 AI 窗口 AI_POLL_CAP_MS = 1800ms
    视频识别服务端实际耗时                    ≈ 3500ms

poll 每轮只能给 AI 1.8s（客户端 callFunction 约 3s 的硬预算决定的，没法放大），
于是**每一轮必然超时**：云函数 1.8s 放弃 → 服务端继续跑完 3.5s → 结果被丢弃 →
下一轮又从头算一遍。循环到 aiAttempts 用尽 → 降级本地引擎 →
前端显示「识别服务暂时不可用」。用户看到的就是「视频识别必失败 + 卡很久」。

## 思路

时间窗口注定了「一次调用算不完」，那就让**第二次调用直接拿到第一次的结果**：

    poll#1  没有缓存 → 自己算（3.5s）→ 云函数 1.8s 放弃，但服务端跑完并写入缓存
    poll#2  命中缓存 → 几十毫秒返回 → 成功

必须配一把 **per-key 计算锁**：否则 poll#1 还在算的时候 poll#2 又开一遍
（两倍的 CPU，且两个请求都在 1.8s 窗口内超时，永远收敛不了）。后来的请求
排队等前一个算完，等不到就返回空由调用方按自己的节奏重试。

## 边界

- 缓存 key 含 schoolId：同一张图在 A/B 两校的档案库不同，候选结果也不同。
- 失败**不缓存**：网络抖动导致的 502 不能被记住 10 分钟。
- 只在**进程内**：云托管必须把最大实例数锁为 1（见 Dockerfile/部署文档），
  否则多实例各缓存一份，命中率会退化 —— 这与特征库 COS 后端的约束一致。
"""
from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Optional

# 全局锁：只保护 _CACHE 这个容器的增删查。
# **绝不能**持着它去做计算或等待 —— 那样等于把所有识别请求串行化。
_GUARD = threading.Lock()
_CACHE: "OrderedDict[str, _Entry]" = OrderedDict()


class _Entry:
    """一条缓存记录。未完成时 `done` 未置位，后来者排队等它。"""

    __slots__ = ("ts", "done", "result", "error")

    def __init__(self) -> None:
        self.ts = time.time()
        self.done = threading.Event()
        self.result: Any = None
        self.error = ""

    def fresh(self, now: float, ttl: float) -> bool:
        return ttl <= 0 or (now - self.ts) <= ttl


def cache_key(*parts: Any) -> str:
    """拼缓存 key。素材链接本身很长且带签名，哈希一下省内存也省比对。"""
    raw = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _evict_locked(now: float, ttl: float, cap: int) -> None:
    """调用方必须已持有 _GUARD，且**在插入新条目之前**调用。

    先清过期，再按容量把已有条目淘汰到 cap-1，给即将插入的这条腾位置。
    写成 `len(_CACHE) > cap` 会差一：淘汰发生在插入之前，插完又变回 cap+1，
    上限形同虚设（测试里 cap=3 插 5 条，最后留下 4 条）。
    """
    if ttl > 0:
        for k in [k for k, e in _CACHE.items() if not e.fresh(now, ttl)]:
            del _CACHE[k]
    while cap > 0 and len(_CACHE) >= cap:
        _CACHE.popitem(last=False)


def get_or_compute(key: str, ttl: float, cap: int, compute: Callable[[], Any],
                   wait_ms: int = 0) -> tuple:
    """取缓存，没有就算；别人正在算就排队等。

    @returns (result, cached)
        cached=True  → 命中缓存（包含「等别人算完」的情况）
        cached=False → 自己算出来的，或者排队超时（result 为 None）

    排队超时返回 (None, False) 而不是抛错：调用方（云函数）本来就有自己的
    超时重试逻辑，让它按原节奏再来一轮即可 —— 那时缓存大概率已经就绪。
    """
    now = time.time()
    with _GUARD:
        _evict_locked(now, ttl, cap)
        entry = _CACHE.get(key)
        if entry is not None and not entry.fresh(now, ttl):
            del _CACHE[key]                 # 过期当作不存在，重建
            entry = None
        if entry is None:
            entry = _Entry()
            _CACHE[key] = entry
            owner = True
        else:
            _CACHE.move_to_end(key)
            owner = False

    if owner:
        try:
            entry.result = compute()
        except Exception as e:  # noqa: BLE001
            # 失败不缓存：否则一次网络抖动会被记住整个 TTL 周期。
            # 异常原样抛给调用方（比如 502 素材下载失败要照常传回云函数）。
            entry.error = str(e)
            with _GUARD:
                if _CACHE.get(key) is entry:
                    del _CACHE[key]
            raise
        finally:
            entry.done.set()
        return entry.result, False

    # 排队者：等到计算者完成，或等到自己的耐心耗尽
    if wait_ms and wait_ms > 0:
        entry.done.wait(wait_ms / 1000.0)
    if entry.done.is_set() and entry.result is not None:
        return entry.result, True
    return None, False


def stats() -> dict:
    """给 /health 用的观察量：缓存里有几条、几条还在算。"""
    with _GUARD:
        total = len(_CACHE)
        pending = sum(1 for e in _CACHE.values() if not e.done.is_set())
    return {"cached": total, "computing": pending}


def reset() -> None:
    """测试用：清空缓存。"""
    with _GUARD:
        _CACHE.clear()


def size() -> int:
    return len(_CACHE)
