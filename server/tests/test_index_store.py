"""特征库后端行为级测试（sqlite_store / cos_store / index_store 门面）。

覆盖：
  1. COS 后端六方法契约（put/get/ids/load/count/clear）与 SQLite 后端逐操作对齐；
  2. 每猫一对象布局：对象键、自描述头部（dim + school_id）、覆盖写、校区过滤；
  3. 持久化语义：清空模块缓存模拟「容器重启」，load 能从 COS 完整恢复；
  4. 冷启动加载：分页翻页（>1000 对象）、损坏对象跳过不炸、非 .bin 键忽略；
  5. 失败 Loud 化：put 失败抛错、clear 批量删除失败抛错且缓存不回滚；
  6. 门面分发：INDEX_BACKEND=sqlite/cos/未知值 三种走向；
  7. 安全：含 "/" ".." 等非法 cat_id 拒绝写入、读取返回 None。

fake COS SDK 通过 sys.modules 注入（本机不装 qcloud_cos 也能跑），
bucket 就是一个内存 dict —— 断言全部打在输出数据上，不匹配源码形状。

运行：
    python server/tests/test_index_store.py
    python -m unittest discover -s server/tests -v
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, SERVER)

# ---- 环境必须在 import app.config 之前设好（config 是 import 时求值）----
os.environ["INDEX_BACKEND"] = "cos"
os.environ["COS_BUCKET"] = "test-bucket-1250000000"
os.environ["COS_REGION"] = "ap-shanghai"
os.environ["COS_SECRET_ID"] = "AKIDfakefakefakefakefakefake"
os.environ["COS_SECRET_KEY"] = "fakesecretfakesecretfakesecret"
os.environ["INDEX_PREFIX"] = "index/"


# ==================== fake COS SDK ====================
class FakeNotFound(Exception):
    pass


class _FakeStream:
    def __init__(self, data: bytes):
        self._data = data

    def read(self, n=-1):
        if n is None or n < 0:
            chunk, self._data = self._data, b""
            return chunk
        chunk, self._data = self._data[:n], self._data[n:]
        return chunk

    def get_raw_stream(self):
        return self


class FakeCosS3Client:
    """内存 bucket：store = {key: bytes}，行为对齐 qcloud_cos 的关键语义。

    - list_objects：Prefix 过滤 + Marker 独占翻页 + IsTruncated/NextMarker；
    - delete_objects：Quiet 模式下只返回失败项，删不存在的键算成功（幂等）；
    - get_object：键不存在抛错（真实 SDK 抛 CosServiceError）。
    """

    last: "FakeCosS3Client | None" = None

    # 故障注入开关（类级，测试里改）
    fail_put = False
    fail_delete_keys: set = set()

    def __init__(self, conf):
        self.conf = conf
        self.store: dict = {}
        FakeCosS3Client.last = self

    # ---- 写入 ----
    def put_object(self, Bucket, Body, Key, **kw):
        if FakeCosS3Client.fail_put:
            raise RuntimeError(" injected put failure")
        if isinstance(Body, str):
            Body = Body.encode("utf-8")
        self.store[Key] = Body
        return {"ETag": '"fake"'}

    # ---- 读取 ----
    def get_object(self, Bucket, Key, **kw):
        if Key not in self.store:
            raise FakeNotFound(f"no such key: {Key}")
        return {"Body": _FakeStream(self.store[Key])}

    # ---- 列表 ----
    def list_objects(self, Bucket, Prefix="", MaxKeys=1000, Marker="", **kw):
        keys = sorted(k for k in self.store if k.startswith(Prefix) and k > (Marker or ""))
        chunk = keys[:MaxKeys]
        truncated = len(keys) > MaxKeys
        return {
            "Contents": [{"Key": k} for k in chunk],
            "IsTruncated": "true" if truncated else "false",
            "NextMarker": chunk[-1] if (chunk and truncated) else "",
        }

    # ---- 批量删除 ----
    def delete_objects(self, Bucket, Delete, **kw):
        objs = Delete.get("Objects") or []
        quiet = str(Delete.get("Quiet", "false")).lower() == "true"
        deleted, errors = [], []
        for o in objs:
            k = o["Key"]
            if k in FakeCosS3Client.fail_delete_keys:
                errors.append({"Key": k, "Code": "InternalError", "Message": "injected"})
                continue
            self.store.pop(k, None)  # 幂等：删不存在的键也算成功
            if not quiet:
                deleted.append({"Key": k})
        return {"Deleted": deleted, "Error": errors}


class _FakeCosConfig:
    def __init__(self, **kw):
        self.__dict__.update(kw)


_fake_module = types.ModuleType("qcloud_cos")
_fake_module.CosConfig = _FakeCosConfig
_fake_module.CosS3Client = FakeCosS3Client
sys.modules["qcloud_cos"] = _fake_module

from app import config, cos_store, index_store, main, sqlite_store  # noqa: E402


def vec(*vals):
    """构造 L2 归一化的 float32 向量（模拟引擎输出）。"""
    import numpy as np

    v = np.asarray(vals, dtype=np.float32)
    return v / np.linalg.norm(v)


V_A = vec(1.0, 0.0, 0.0)                    # dim=3
V_B = vec(0.0, 1.0, 0.0, 0.0, 0.0)          # dim=5
V_C = vec(0.0, 0.0, 0.0, 0.0, 0.0, 1.0)     # dim=6
V_A2 = vec(0.6, 0.8, 0.0)                   # A 的覆盖值


def reset_cos():
    """清空 cos_store 进程内状态，换一个空 bucket，返回新 client。"""
    FakeCosS3Client.fail_put = False
    FakeCosS3Client.fail_delete_keys = set()
    FakeCosS3Client.last = None
    cos_store._cache.clear()
    cos_store._loaded = False
    cos_store._cli = None
    cli = cos_store._client()  # 触发构造，拿到带空 store 的实例
    assert FakeCosS3Client.last is cli
    return cli


class TestCosStore(unittest.TestCase):
    def setUp(self):
        self.cli = reset_cos()

    # ---------- 基本契约 ----------
    def test_put_get_roundtrip(self):
        cos_store.put("c1", "s1", V_A, source="build")
        got = cos_store.get("c1")
        self.assertIsNotNone(got)
        self.assertEqual(got.dtype, "float32")
        self.assertEqual(got.shape, (3,))
        self.assertAlmostEqual(float(got[0]), 1.0, places=6)

    def test_object_layout(self):
        cos_store.put("c1", "校区-01", V_A)
        self.assertEqual(list(self.cli.store.keys()), ["index/c1.bin"])
        # 头部自描述：dim=3、school_id utf-8 5+1 字节，尾部 1 字节特征版本
        body = self.cli.store["index/c1.bin"]
        self.assertEqual(len(body), 8 + len("校区-01".encode()) + 12 + 1)
        self.assertEqual(body[-1], config.FEATURE_POOL_VERSION & 0xFF)

    def test_v1_object_without_version_byte_is_rejected(self):
        """防呆：换池化策略后旧向量（同维不同义）必须被当不存在，逼一次重建。"""
        cos_store.put("c1", "s1", V_A)
        body = bytearray(self.cli.store["index/c1.bin"])
        # 改桶里的对象后必须清空缓存（模拟重启后的冷加载），否则 get 走缓存
        self.cli.store["index/c1.bin"] = bytes(body[:-1])            # v1：无版本字节
        cos_store._cache.clear()
        cos_store._loaded = False
        self.assertIsNone(cos_store.get("c1"))
        self.assertEqual(cos_store.count(), 0)
        cos_store.put("c1", "s1", V_A)
        body = bytearray(self.cli.store["index/c1.bin"])
        body[-1] = (config.FEATURE_POOL_VERSION + 1) & 0xFF          # 版本不符
        self.cli.store["index/c1.bin"] = bytes(body)
        cos_store._cache.clear()
        cos_store._loaded = False
        self.assertIsNone(cos_store.get("c1"))
        # 当前版本的对象不受影响
        cos_store.put("c1", "s1", V_A)
        self.assertIsNotNone(cos_store.get("c1"))

    def test_get_missing_returns_none(self):
        self.assertIsNone(cos_store.get("nope"))

    def test_overwrite_updates_value_and_school(self):
        cos_store.put("c1", "s1", V_A)
        cos_store.put("c1", "s2", V_A2)
        got = cos_store.get("c1")
        self.assertAlmostEqual(float(got[0]), 0.6, places=6)
        self.assertEqual(cos_store.ids("s1"), [])
        self.assertEqual(cos_store.ids("s2"), ["c1"])

    def test_school_filtering(self):
        cos_store.put("c1", "s1", V_A)
        cos_store.put("c2", "s2", V_B)
        cos_store.put("c3", "s1", V_C)
        self.assertEqual(sorted(cos_store.ids()), ["c1", "c2", "c3"])
        self.assertEqual(sorted(cos_store.ids("s1")), ["c1", "c3"])
        self.assertEqual(cos_store.ids("s2"), ["c2"])
        self.assertEqual(cos_store.count(), 3)
        self.assertEqual(cos_store.count("s1"), 2)
        self.assertEqual(cos_store.count("s2"), 1)

    def test_load_scoped_and_full(self):
        cos_store.put("c1", "s1", V_A)
        cos_store.put("c2", "s2", V_B)
        all_bank = cos_store.load()
        self.assertEqual(sorted(all_bank.keys()), ["c1", "c2"])
        s1 = cos_store.load("s1")
        self.assertEqual(list(s1.keys()), ["c1"])
        self.assertAlmostEqual(float(s1["c1"][0]), 1.0, places=6)
        # 覆盖写后的值能被 load 看到（缓存与 COS 一致）
        cos_store.put("c1", "s1", V_A2)
        self.assertAlmostEqual(float(cos_store.load("s1")["c1"][0]), 0.6, places=6)

    def test_mixed_dims(self):
        cos_store.put("small", "s1", V_A)   # dim 3
        cos_store.put("big", "s1", V_B)     # dim 5
        bank = cos_store.load("s1")
        self.assertEqual(bank["small"].shape, (3,))
        self.assertEqual(bank["big"].shape, (5,))

    # ---------- 清空 ----------
    def test_clear_school_scoped(self):
        cos_store.put("c1", "s1", V_A)
        cos_store.put("c2", "s2", V_B)
        removed = cos_store.clear("s1")
        self.assertEqual(removed, 1)
        self.assertEqual(cos_store.count("s1"), 0)
        self.assertEqual(cos_store.count(), 1)
        self.assertEqual(list(self.cli.store.keys()), ["index/c2.bin"])

    def test_clear_all_removes_orphans(self):
        cos_store.put("c1", "s1", V_A)
        # 直接往 bucket 里塞两个「漏网对象」：冷启动加载失败的损坏对象 + 非 .bin 键
        self.cli.store["index/broken.bin"] = b"garbage!"
        self.cli.store["index/notes.txt"] = b"hello"
        removed = cos_store.clear()
        self.assertEqual(removed, 2)  # c1 + broken；notes.txt 不是 .bin 不动
        self.assertEqual(cos_store.count(), 0)
        self.assertEqual(list(self.cli.store.keys()), ["index/notes.txt"])

    # ---------- 持久化 / 重启语义 ----------
    def test_cold_start_reload_from_cos(self):
        cos_store.put("c1", "s1", V_A)
        cos_store.put("c2", "s2", V_B)
        # 模拟容器重启：丢掉进程内全部状态
        cos_store._cache.clear()
        cos_store._loaded = False
        bank = cos_store.load()
        self.assertEqual(sorted(bank.keys()), ["c1", "c2"])
        self.assertAlmostEqual(float(bank["c1"][0]), 1.0, places=6)
        self.assertEqual(cos_store.count("s2"), 1)
        self.assertTrue(cos_store._loaded)

    def test_get_fallback_promotes_external_write(self):
        cos_store.put("c1", "s1", V_A)
        cos_store.load()  # 先触发一次冷启动加载，让 _loaded=True
        self.assertTrue(cos_store._loaded)
        # 冷启动完成后「别的进程」直接写了一个对象（单实例部署不会发生，
        # 但 get 的兜底直查要能发现它，并提升进缓存对后续读可见）
        self.cli.store["index/c9.bin"] = cos_store._encode("s9", V_B)
        got = cos_store.get("c9")
        self.assertIsNotNone(got)
        self.assertEqual(got.shape, (5,))
        self.assertEqual(cos_store.ids("s9"), ["c9"])

    # ---------- 冷启动加载的扰动 ----------
    def test_corrupt_object_skipped_not_fatal(self):
        cos_store.put("c1", "s1", V_A)
        self.cli.store["index/bad.bin"] = b"garbage!"
        self.cli.store["index/bad2.bin"] = cos_store._encode("s1", V_A)[:-4]  # 截断
        cos_store._cache.clear()
        cos_store._loaded = False
        bank = cos_store.load()
        self.assertEqual(list(bank.keys()), ["c1"])
        self.assertIsNone(cos_store.get("bad"))
        self.assertIsNone(cos_store.get("bad2"))

    def test_list_pagination(self):
        for i in range(2500):
            self.cli.store[f"index/cat{i:05d}.bin"] = cos_store._encode("s1", V_A)
        cos_store._loaded = False
        cos_store._cache.clear()
        self.assertEqual(cos_store.count(), 2500)
        self.assertEqual(len(cos_store.load()), 2500)

    def test_non_bin_keys_ignored(self):
        self.cli.store["index/"] = b""           # 控制台常见占位目录键
        self.cli.store["index/manifest.json"] = b"{}"
        self.cli.store["index/c1.bin"] = cos_store._encode("s1", V_A)
        cos_store._loaded = False
        self.assertEqual(cos_store.ids(), ["c1"])

    # ---------- 失败必须吵 ----------
    def test_put_failure_propagates(self):
        FakeCosS3Client.fail_put = True
        with self.assertRaises(RuntimeError):
            cos_store.put("c1", "s1", V_A)
        self.assertEqual(cos_store.count(), 0)  # 缓存不被污染
        self.assertEqual(self.cli.store, {})

    def test_clear_delete_failure_propagates_and_keeps_cache(self):
        cos_store.put("c1", "s1", V_A)
        FakeCosS3Client.fail_delete_keys = {"index/c1.bin"}
        with self.assertRaises(RuntimeError):
            cos_store.clear("s1")
        # 删除失败 → 缓存不回滚（内存与 COS 仍然一致地说「存在」）
        self.assertEqual(cos_store.count(), 1)
        self.assertIn("index/c1.bin", self.cli.store)

    # ---------- 安全 ----------
    def test_invalid_cat_id_rejected(self):
        for bad in ["a/b", "..", "../x", "a\\b", "", "x" * 201, "带/斜杠", None, 123]:
            with self.assertRaises(ValueError):
                cos_store.put(bad, "s1", V_A)
        self.assertEqual(self.cli.store, {})

    def test_invalid_cat_id_read_returns_none(self):
        for bad in ["a/b", "..", "", "x" * 201, None, 123]:
            self.assertIsNone(cos_store.get(bad))

    # ---------- 配置缺失要吵 ----------
    def test_missing_config_raises(self):
        saved = (config.COS_BUCKET, config.COS_REGION, config.COS_SECRET_ID, config.COS_SECRET_KEY)
        cos_store._cli = None
        try:
            config.COS_BUCKET = ""
            with self.assertRaises(RuntimeError) as ctx:
                cos_store._client()
            self.assertIn("COS_BUCKET", str(ctx.exception))
        finally:
            (config.COS_BUCKET, config.COS_REGION,
             config.COS_SECRET_ID, config.COS_SECRET_KEY) = saved
            cos_store._cli = None


class TestSqliteStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="catcampus-idx-")
        self._saved_db = config.INDEX_DB
        config.INDEX_DB = Path(self.tmp) / "index.sqlite3"

    def tearDown(self):
        config.INDEX_DB = self._saved_db

    def test_roundtrip_and_clear(self):
        sqlite_store.put("c1", "s1", V_A)
        sqlite_store.put("c2", "s2", V_B)
        self.assertEqual(sqlite_store.count(), 2)
        self.assertEqual(sorted(sqlite_store.ids("s1")), ["c1"])
        got = sqlite_store.get("c1")
        self.assertEqual(got.dtype, "float32")
        self.assertAlmostEqual(float(got[0]), 1.0, places=6)
        self.assertEqual(sqlite_store.clear("s1"), 1)
        self.assertEqual(sqlite_store.count(), 1)
        self.assertEqual(sqlite_store.clear(), 1)
        self.assertEqual(sqlite_store.count(), 0)
        self.assertTrue(config.INDEX_DB.exists())


class TestFacadeDispatch(unittest.TestCase):
    """门面按 INDEX_BACKEND 分发：sqlite / cos / 未知值。"""

    def setUp(self):
        self._env_backup = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_backup)
        importlib.reload(config)
        importlib.reload(index_store)

    def _reload_with(self, **env):
        for k in ("INDEX_BACKEND", "INDEX_DB"):
            os.environ.pop(k, None)
        os.environ.update(env)
        importlib.reload(config)
        importlib.reload(index_store)

    def test_dispatch_sqlite(self):
        tmp = tempfile.mkdtemp(prefix="catcampus-facade-")
        self._reload_with(INDEX_BACKEND="sqlite", INDEX_DB=os.path.join(tmp, "i.sqlite3"))
        self.assertEqual(index_store.BACKEND_NAME, "sqlite_store")
        index_store.put("c1", "s1", V_A)
        self.assertIsNotNone(index_store.get("c1"))
        self.assertEqual(index_store.count("s1"), 1)
        self.assertEqual(index_store.clear("s1"), 1)

    def test_dispatch_cos(self):
        reset_cos()
        self._reload_with(INDEX_BACKEND="cos")
        self.assertEqual(index_store.BACKEND_NAME, "cos_store")
        index_store.put("c1", "s1", V_A)
        self.assertIsNotNone(index_store.get("c1"))
        self.assertEqual(index_store.count(), 1)
        self.assertEqual(index_store.clear(), 1)

    def test_backend_name_default_and_case_insensitive(self):
        # 大写 / 带空格也要能识别
        reset_cos()
        self._reload_with(INDEX_BACKEND=" COS ")
        self.assertEqual(index_store.BACKEND_NAME, "cos_store")

    def test_dispatch_unknown_raises(self):
        with self.assertRaises(RuntimeError):
            self._reload_with(INDEX_BACKEND="redis")


class TestBackendParity(unittest.TestCase):
    """同一串操作打到两个后端上，可观测输出必须一致（契约不变证明）。"""

    def test_parity(self):
        cos_cli = reset_cos()
        tmp = tempfile.mkdtemp(prefix="catcampus-parity-")
        saved_db = config.INDEX_DB
        config.INDEX_DB = Path(tmp) / "p.sqlite3"
        try:
            ops = [
                ("put", "c1", "s1", V_A),
                ("put", "c2", "s2", V_B),
                ("put", "c3", "s1", V_C),
                ("put", "c1", "s1", V_A2),          # 覆盖
                ("put", "c4", "s3", V_A),
            ]
            for backend in (sqlite_store, cos_store):
                for _, cid, sid, v in ops:
                    backend.put(cid, sid, v)
                self.assertEqual(sorted(backend.ids()), ["c1", "c2", "c3", "c4"], backend.__name__)
                self.assertEqual(sorted(backend.ids("s1")), ["c1", "c3"], backend.__name__)
                self.assertEqual(backend.count(), 4, backend.__name__)
                bank = backend.load("s1")
                self.assertEqual(sorted(bank.keys()), ["c1", "c3"], backend.__name__)
                self.assertAlmostEqual(float(bank["c1"][0]), 0.6, places=6, msg=backend.__name__)
                self.assertEqual(backend.clear("s2"), 1, backend.__name__)
                self.assertEqual(backend.count(), 3, backend.__name__)
                self.assertEqual(backend.clear(), 3, backend.__name__)
                self.assertEqual(backend.count(), 0, backend.__name__)
            # COS 侧对应地也被清空
            self.assertEqual(cos_cli.store, {})
        finally:
            config.INDEX_DB = saved_db


class TestIndexDelete(unittest.TestCase):
    """单只猫的向量删除 —— 删档案时必须配套，否则留下幽灵残留。

    背景（2026-10-25 现场）：6 个档案、特征库里 7 条向量。
    多出来那条是被删掉的猫留下的，因为特征库按 `cat_id` 存对象，
    而删档案从来不碰特征文件（服务端以前没有删除接口）。
    """

    def setUp(self):
        reset_cos()

    def test_delete_removes_entry(self):
        cos_store.put("c1", "s1", V_A)
        cos_store.put("c2", "s1", V_B)
        self.assertEqual(cos_store.count(), 2)
        self.assertTrue(cos_store.delete("c1"))
        self.assertIsNone(cos_store.get("c1"))
        self.assertIsNotNone(cos_store.get("c2"), "只删指定的那只，不能误伤")
        self.assertEqual(cos_store.count(), 1)

    def test_delete_missing_returns_false(self):
        self.assertFalse(cos_store.delete("nope"))

    def test_delete_evicts_cache_so_put_after_works(self):
        """删掉后立刻重建，必须写进新值（缓存没清的话会读到幽灵）。"""
        cos_store.put("c1", "s1", V_A)
        cos_store.delete("c1")
        cos_store.put("c1", "s1", V_A2)
        got = cos_store.get("c1")
        self.assertAlmostEqual(float(got[0]), 0.6, places=6)


class TestDegradation(unittest.TestCase):
    """特征库后端挂了必须降级，绝不能让健康检查 500（否则平台判定实例不健康、反复重启）。

    背景：2026-10-14 云托管上 /health 返回 500（纯文本 Internal Server Error，看不到原因），
    而 500 会让平台不停重启实例，故障越修越乱。特征库是可再生数据，带病可用优于整体不可用。
    """

    def setUp(self):
        reset_cos()

    def test_snapshot_ok(self):
        snap = main.index_health()
        self.assertEqual(snap["indexed"], 0)
        self.assertEqual(snap["indexBackend"], "cos_store")
        self.assertNotIn("indexError", snap)

    def test_snapshot_degrades_when_backend_down(self):
        with mock.patch.object(index_store, "count", side_effect=RuntimeError("cos is down")):
            snap = main.index_health("s1")
        self.assertEqual(snap["indexed"], -1)
        self.assertEqual(snap["indexBackend"], "cos_store")
        self.assertIn("cos is down", snap["indexError"])
        self.assertIn("RuntimeError", snap["indexError"])

    def test_snapshot_degrades_on_missing_sdk(self):
        # 镜像里没装 cos-python-sdk-v5 时就是这个错，必须能在 /health 里一眼看到
        with mock.patch.object(index_store, "count",
                               side_effect=ModuleNotFoundError("No module named 'qcloud_cos'")):
            snap = main.index_health()
        self.assertEqual(snap["indexed"], -1)
        self.assertIn("qcloud_cos", snap["indexError"])

    def test_search_degrades_to_no_candidates(self):
        with mock.patch.object(index_store, "load", side_effect=RuntimeError("cos is down")):
            out, info = main.search(V_A, [], "s1")
        self.assertEqual(out, [])
        # 降级也要带诊断：上游靠 indexed=0 判断「没建库」而不是「没有相似的猫」
        self.assertEqual(info["indexed"], 0)
        self.assertIn("cos is down", info["bankReadError"])


class TestHealthScope(unittest.TestCase):
    """`/health` 的双口径：`indexed` 按校、`indexedTotal` 恒为全库。

    守的是 2026-10-25 那个现场：管理后台「识别引擎」卡显示**特征库 11 只**、
    下方「花色比对」卡却是**本校 7 条**（档案 6）—— 管理员以为出了灵异事件。
    实际是两个数字各说各话：`/health` 原来不带 schoolId，返回的是**全库**
    （含其它学校 + 已删档案的残留向量），而花色比对卡按校查。
    两边统一到「本校优先 + 全库注明」的口径，差值才能一眼解释。
    """

    def setUp(self):
        reset_cos()

    def tearDown(self):
        reset_cos()

    def test_scoped_indexed_and_total(self):
        cos_store.put("a1", "s1", V_A)
        cos_store.put("a2", "s1", V_B)
        cos_store.put("b1", "s2", V_C)
        h = main.health(schoolId="s1")
        self.assertEqual(h["indexed"], 2, "按校：只统计 s1")
        self.assertEqual(h["indexedTotal"], 3, "全库：三个都在")
        self.assertTrue(h["indexedScoped"])

    def test_unscoped_is_full_bank(self):
        cos_store.put("a1", "s1", V_A)
        cos_store.put("b1", "s2", V_B)
        h = main.health()
        self.assertEqual(h["indexed"], 2, "不传 schoolId 时 indexed 就是全库（兼容旧语义）")
        self.assertEqual(h["indexedTotal"], 2)
        self.assertFalse(h["indexedScoped"])

    def test_backend_error_keeps_degradation(self):
        """双口径下后端挂了照样降级，不能因为多查一次全库就把 /health 打成 500。"""
        with mock.patch.object(index_store, "count", side_effect=RuntimeError("cos is down")):
            h = main.health(schoolId="s1")
        self.assertEqual(h["indexed"], -1)
        self.assertEqual(h["indexedTotal"], -1)
        self.assertIn("cos is down", h["indexError"])

    def test_ensure_index_never_raises(self):
        cats = [main.CatRef(id="c1", name="小花", photos=["https://example.com/a.jpg"])]
        with mock.patch.object(index_store, "get", side_effect=RuntimeError("cos is down")):
            main.ensure_index(cats, "s1")  # 补库是尽力而为的副作用，吞掉异常


class TestIndexIds(unittest.TestCase):
    """GET /v1/index/ids —— 管理端「哪些档案还没录入」的唯一真相来源。

    为什么不能查云库的 cats.aiIndexAt：那是云函数侧的乐观记账，
    服务端补库失败时它照样有值。管理端照它显示就会出现
    「界面全部已入库、实际只认得 1 只」。
    """

    def setUp(self):
        reset_cos()

    def test_returns_bank_ids(self):
        with mock.patch.object(index_store, "ids", return_value=["c1", "c2"]), \
             mock.patch.object(index_store, "count", return_value=2):
            r = main.index_ids("s1")
        self.assertEqual(r["ids"], ["c1", "c2"])
        self.assertEqual(r["total"], 2)
        self.assertTrue(r["ok"])

    def test_503_when_bank_down(self):
        # 后端不可用必须显式 503，不能返回空列表被误读成「一只都没入库」
        from fastapi import HTTPException
        with mock.patch.object(index_store, "ids", side_effect=RuntimeError("cos is down")):
            with self.assertRaises(HTTPException) as ctx:
                main.index_ids("s1")
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIn("cos is down", ctx.exception.detail)


class TestMissingKeyIsNotAnError(unittest.TestCase):
    """多实例并存时「对象不存在」是常态，不能刷成 ERROR/WARNING。

    现场日志里 `NoSuchKey index/<id>.bin` 紧跟着一次 put —— 那是别的实例把
    「缓存里还留着、COS 上已被删」的猫按需回源。按故障打会淹没真问题。
    """

    def test_is_missing_recognises_sdk_error(self):
        import app.cos_store as cos
        self.assertTrue(cos._is_missing("CosServiceError: NoSuchKey ... resource /index/x.bin"))
        self.assertTrue(cos._is_missing("HTTP 404 Not Found"))
        self.assertFalse(cos._is_missing("AccessDenied"))
        self.assertFalse(cos._is_missing("connect timeout"))

    def test_fetch_logs_info_for_missing(self):
        import app.cos_store as cos
        cos._loaded = True
        cos._cache.clear()
        with mock.patch.object(cos, "_client") as cli:
            cli.return_value.get_object.side_effect = RuntimeError(
                "CosServiceError: {'code': 'NoSuchKey'}")
            with mock.patch.object(cos.log, "info") as info, \
                 mock.patch.object(cos.log, "warning") as warn:
                self.assertIsNone(cos._fetch("index/gone.bin"))
        self.assertTrue(info.called, "不存在应为 INFO")
        self.assertFalse(warn.called, "不存在不应打 WARNING")

    def test_fetch_logs_warning_for_real_failure(self):
        import app.cos_store as cos
        cos._loaded = True
        cos._cache.clear()
        with mock.patch.object(cos, "_client") as cli:
            cli.return_value.get_object.side_effect = RuntimeError("AccessDenied")
            with mock.patch.object(cos.log, "info") as info, \
                 mock.patch.object(cos.log, "warning") as warn:
                self.assertIsNone(cos._fetch("index/x.bin"))
        self.assertTrue(warn.called, "真故障必须 WARNING")
        self.assertFalse(info.called)


class TestEnsureIndexSkips(unittest.TestCase):
    """冷启动补库的两个「少做一次重复劳动」保证。

    线上日志（2026-10-15）里同一条照片 URL 被 GET 了两次、整条识别链路多约 1s：
    识别自己下了一次，补库又下了一次。下面两条断言把这个行为钉死。
    """

    def setUp(self):
        import app.main as m
        self.main = m

    def test_skip_ids_not_downloaded(self):
        cats = [self.main.CatRef(id="self", name="小橘", photos=["https://example.com/a.jpg"])]
        with mock.patch.object(self.main.index_store, "get", return_value=None), \
             mock.patch.object(self.main.media, "fetch_image") as fetch:
            self.main.ensure_index(cats, "s1", skip_ids={"self"})
        fetch.assert_not_called()

    def test_skipped_cat_still_not_fetched_but_others_are(self):
        cats = [
            self.main.CatRef(id="self", name="小橘", photos=["https://example.com/a.jpg"]),
            self.main.CatRef(id="other", name="小灰灰", photos=["https://example.com/b.jpg"]),
        ]
        with mock.patch.object(self.main.index_store, "get", return_value=None), \
             mock.patch.object(self.main.media, "fetch_image", return_value=None) as fetch:
            self.main.ensure_index(cats, "s1", skip_ids={"self"})
        called = [c.args[0] for c in fetch.call_args_list]
        self.assertEqual(called, ["https://example.com/b.jpg"])

    def test_indexed_cat_still_skipped(self):
        cats = [self.main.CatRef(id="other", name="小灰灰", photos=["https://example.com/b.jpg"])]
        with mock.patch.object(self.main.index_store, "get", return_value=V_A), \
             mock.patch.object(self.main.media, "fetch_image") as fetch:
            self.main.ensure_index(cats, "s1")
        fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
