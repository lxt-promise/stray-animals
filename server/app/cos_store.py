"""COS 对象存储后端特征库：每只猫一个对象，云托管（无持久盘）也能持久化。

布局（配合 INDEX_BACKEND=cos 使用）：
    <INDEX_PREFIX><cat_id>.bin     例如 index/cat_abc123.bin

对象体自描述，头部 8 字节 + 校区 id + 向量：
    [uint32 dim][uint32 school_id 长度][school_id utf-8][dim × float32]

为什么是「每猫一对象」而不是「整库一个对象」：
    1. 天然原子 —— 新增=PUT、删除=DELETE，不存在 read-modify-write 竞争；
    2. 无写放大 —— 更新一只猫只传 4KB，不会把整校特征库反复重传；
    3. 语义对齐 —— SQLite 版 cat_id 是主键，一只猫一条记录，一一对应。

为什么还要内存缓存：
    识别热路径每次请求都要 load(school_id)（全量向量做矩阵乘）和
    get(cat_id)（补库判存，一次最多 40 次）。直连 COS 的话每次识别
    几百次 GET，延迟不可接受。所以容器内维护一份全量缓存：
      - 冷启动（首次访问）list + 并发 GET 全量灌入（几百个对象约 1~3s，一次性）；
      - 之后所有读走内存，零 COS 请求；
      - 写（put/clear）先落 COS 再更新缓存 —— COS 永远是真相来源。
    单实例部署（云托管最大实例数锁 1）下该模型严格正确。

source 参数仅为接口对齐保留，不落对象（SQLite 版存了也没人读）。
"""
from __future__ import annotations

import logging
import re
import struct
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Tuple

import numpy as np

from . import config

log = logging.getLogger("catcampus.index")

# 对象键只允许窄字符集：cat_id 来自外部 payload，必须防路径穿越
# （含 "/"、"\", 控制字符的 id 会写到前缀外的 key）。
# 首字符另限字母/数字/_/@：排掉 ".."、".x"、"-x" 这类点/线开头的怪键。
_CAT_ID_RE = re.compile(r"^[A-Za-z0-9_@][A-Za-z0-9._@-]{0,199}$")

# [dim, school_id 字节长度]
_HEADER = struct.Struct("<II")
_HEADER_LEN = _HEADER.size  # 8

_DIM_MAX = 100_000          # 防御：头部声称的维度不可能超过这个数
_SCHOOL_MAX = 4096          # 防御：校区 id 长度上限
_DELETE_BATCH = 500         # COS delete_objects 单次上限 1000，留余量
_LOAD_WORKERS = 8           # 冷启动并发 GET 的线程数

# cat_id -> (school_id, embedding)；进程内全量缓存，_ensure_loaded 填充
_cache: Dict[str, Tuple[str, np.ndarray]] = {}
_loaded = False
_lock = threading.RLock()
_cli = None


# ---------------- 内部工具 ----------------
def _prefix() -> str:
    p = config.INDEX_PREFIX or "index/"
    return p if p.endswith("/") else p + "/"


def _safe_key(cat_id: str) -> Optional[str]:
    """合法 cat_id → 对象键；不合法返回 None（读路径用它判「查无此猫」）。"""
    if not isinstance(cat_id, str) or not _CAT_ID_RE.match(cat_id):
        return None
    return _prefix() + cat_id + ".bin"


def _require_key(cat_id: str) -> str:
    key = _safe_key(cat_id)
    if key is None:
        raise ValueError(f"非法 cat_id（拒绝写入 COS）: {cat_id!r}")
    return key


def _client():
    """延迟构造 COS 客户端：sqlite 后端完全不依赖 SDK，装没装都不影响。"""
    global _cli
    if _cli is not None:
        return _cli
    from qcloud_cos import CosConfig, CosS3Client

    missing = [k for k, v in (
        ("COS_BUCKET", config.COS_BUCKET),
        ("COS_REGION", config.COS_REGION),
        ("COS_SECRET_ID", config.COS_SECRET_ID),
        ("COS_SECRET_KEY", config.COS_SECRET_KEY),
    ) if not v]
    if missing:
        raise RuntimeError(
            "INDEX_BACKEND=cos 但缺少配置: " + ", ".join(missing)
            + "（在环境变量中补齐后重新部署）"
        )
    conf = CosConfig(
        Region=config.COS_REGION,
        SecretId=config.COS_SECRET_ID,
        SecretKey=config.COS_SECRET_KEY,
        Token=config.COS_TOKEN or None,
        Endpoint=config.COS_ENDPOINT or "",
    )
    _cli = CosS3Client(conf)
    return _cli


def _read_body(resp: dict) -> bytes:
    stream = resp.get("Body") if isinstance(resp, dict) else None
    if stream is None:
        raise RuntimeError("COS 响应缺少 Body")
    try:
        return stream.get_raw_stream().read()
    except AttributeError:
        return stream.read()


def _encode(school_id: str, emb: np.ndarray) -> bytes:
    sb = (school_id or "").encode("utf-8")
    vec = np.ascontiguousarray(emb, dtype=np.float32).reshape(-1)
    # 尾部 1 字节特征版本：池化/算法变更时递增（见 _decode 的版本门禁）
    return (_HEADER.pack(int(vec.shape[0]), len(sb)) + sb + vec.tobytes()
            + bytes([int(config.FEATURE_POOL_VERSION) & 0xFF]))


def _decode(body: bytes) -> Optional[Tuple[str, np.ndarray]]:
    """对象体 → (school_id, 向量)；损坏或**特征版本不符**返回 None（调用方跳过）。

    版本门禁：v1（无版本字节）与当前版本不符的对象一律当不存在 ——
    换池化策略后新旧向量维度相同但语义完全不同，混算会乱匹配；
    宁可让特征库暂时「变空」逼一次重建，也不要静默产出错误结果。
    """
    if not isinstance(body, (bytes, bytearray)) or len(body) < _HEADER_LEN:
        return None
    dim, slen = _HEADER.unpack_from(body, 0)
    if dim <= 0 or dim > _DIM_MAX or slen > _SCHOOL_MAX:
        return None
    vec_end = _HEADER_LEN + slen + dim * 4
    if len(body) < vec_end:
        return None
    if len(body) != vec_end + 1 or body[vec_end] != (int(config.FEATURE_POOL_VERSION) & 0xFF):
        return None   # v1 旧格式（无版本字节）或版本不符
    school = bytes(body[_HEADER_LEN:_HEADER_LEN + slen]).decode("utf-8", "replace")
    emb = np.frombuffer(body, dtype=np.float32, count=dim, offset=_HEADER_LEN + slen)
    return school, emb


def _is_missing(err: object) -> bool:
    """是不是「对象不存在」。多实例并存时这条**必然**出现且完全正常：
    缓存里残留着一只已被删除/被其它实例重建的猫，get() 按需回源就会 404。
    按 ERROR 打会把日志刷成一片红，真正的故障反而被淹掉。"""
    s = str(err)
    return "NoSuchKey" in s or "404" in s


def _fetch(key: str) -> Optional[Tuple[str, str, np.ndarray]]:
    """GET 单个对象 → (cat_id, school_id, 向量)；任何失败都返回 None 不抛。"""
    try:
        resp = _client().get_object(Bucket=config.COS_BUCKET, Key=key)
        body = _read_body(resp)
    except Exception as e:  # noqa: BLE001 —— 单对象失败不能拖垮整次冷启动
        if _is_missing(e):
            log.info("COS 对象 %s 不存在（已删除或尚未写入），跳过", key)
        else:
            log.warning("COS GET %s 失败: %s", key, e)
        return None
    parsed = _decode(body)
    if parsed is None:
        # 版本门禁命中也走这里（v1 旧格式按设计丢弃），是**预期行为**不是故障
        log.warning("COS 对象 %s 不可用（格式/特征版本不符），已跳过", key)
        return None
    school, emb = parsed
    cat_id = key[len(_prefix()):-len(".bin")]
    return cat_id, school, emb


def _list_keys() -> List[str]:
    cli = _client()
    keys: List[str] = []
    marker = ""
    while True:
        resp = cli.list_objects(
            Bucket=config.COS_BUCKET, Prefix=_prefix(), MaxKeys=1000, Marker=marker
        )
        contents = resp.get("Contents") or []
        keys.extend(o["Key"] for o in contents if str(o.get("Key", "")).endswith(".bin"))
        if str(resp.get("IsTruncated", "false")).lower() != "true":
            return keys
        marker = resp.get("NextMarker") or (contents[-1]["Key"] if contents else "")
        if not marker:  # 防御：响应畸形时退出，避免死循环
            return keys


def _delete_keys(keys: List[str]) -> int:
    """批量删除，返回成功条数；任何一个失败都抛错（宁可吵，不可静默丢数据）。"""
    if not keys:
        return 0
    cli = _client()
    deleted = 0
    for i in range(0, len(keys), _DELETE_BATCH):
        chunk = keys[i:i + _DELETE_BATCH]
        resp = cli.delete_objects(
            Bucket=config.COS_BUCKET,
            Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": "true"},
        )
        errors = resp.get("Error") or []
        if errors:
            detail = "; ".join(
                "%s -> %s" % (e.get("Key"), e.get("Code") or e.get("Message") or "?")
                for e in errors[:5]
            )
            raise RuntimeError(f"COS 批量删除失败（本批 {len(chunk)} 个，失败 {len(errors)} 个）: {detail}")
        deleted += len(chunk)
    return deleted


def _ensure_loaded() -> None:
    """冷启动全量加载：list + 并发 GET 灌满缓存。幂等，线程安全。"""
    global _loaded
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        _client()  # 先初始化（主线程），避免并发首调
        keys = _list_keys()
        if keys:
            with ThreadPoolExecutor(max_workers=_LOAD_WORKERS) as ex:
                results = list(ex.map(_fetch, keys))
            for r in results:
                if r is not None:
                    cid, sid, emb = r
                    _cache[cid] = (sid, emb)
        _loaded = True
        log.info("COS 特征库冷启动加载完成：%d/%d 个对象可用", len(_cache), len(keys))


# ---------------- 对外接口（与 sqlite_store 契约一致） ----------------
def put(cat_id: str, school_id: str, emb: np.ndarray, source: str = "recognize") -> None:
    """写入/更新一只猫的向量。先落 COS，成功后更新缓存。"""
    key = _require_key(cat_id)
    vec = np.ascontiguousarray(emb, dtype=np.float32).reshape(-1)
    _client().put_object(Bucket=config.COS_BUCKET, Body=_encode(school_id or "", vec), Key=key)
    with _lock:
        _cache[cat_id] = (school_id or "", vec)


def get(cat_id: str) -> Optional[np.ndarray]:
    """取一只猫的向量；没有返回 None。

    缓存未命中时会直查一次 COS：覆盖「其它进程刚写入」或「冷启动时
    该对象 GET 失败」两种情况，命中则补进缓存。
    """
    key = _safe_key(cat_id)
    if key is None:
        return None
    _ensure_loaded()
    with _lock:
        hit = _cache.get(cat_id)
    if hit is not None:
        return hit[1]
    r = _fetch(key)
    if r is None:
        return None
    _, school, emb = r
    with _lock:
        _cache[cat_id] = (school, emb)
    return emb


def ids(school_id: str = "") -> List[str]:
    _ensure_loaded()
    with _lock:
        return [cid for cid, (sid, _) in _cache.items() if not school_id or sid == school_id]


def load(school_id: str = "") -> Dict[str, np.ndarray]:
    """一次性取出某校区全部向量，供 numpy 批量矩阵乘（直接返回缓存引用，勿原地改）。"""
    _ensure_loaded()
    with _lock:
        return {cid: emb for cid, (sid, emb) in _cache.items() if not school_id or sid == school_id}


def count(school_id: str = "") -> int:
    return len(ids(school_id))


def clear(school_id: str = "") -> int:
    """清空特征库。

    school_id 为空时清空全部（用于「档案库即真相来源」的整体重建）；
    否则只清该校区。返回被删除的条数。
    全量清空还会顺手删掉冷启动时加载失败/损坏的漏网对象。
    """
    _ensure_loaded()
    with _lock:
        targets = [cid for cid, (sid, _) in _cache.items() if not school_id or sid == school_id]
    orphan_keys: List[str] = []
    if not school_id:
        known = {_prefix() + cid + ".bin" for cid in targets}
        orphan_keys = [k for k in _list_keys() if k not in known]
    deleted = _delete_keys([_prefix() + cid + ".bin" for cid in targets] + orphan_keys)
    with _lock:
        for cid in targets:
            _cache.pop(cid, None)
    return deleted
