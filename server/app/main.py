"""
喵园 CatCampus 自建识别服务。

对外只有一个核心接口 POST /v1/recognize —— 它返回的字段结构与云函数
cloudfunctions/catcampus/lib/vision.js 的契约完全一致，所以接上之后前端零改动。

下游需要在云函数的环境变量里配：
    AI_ENDPOINT = https://ai.yourdomain.com/v1/recognize
    AI_TOKEN    = 与服务端 API_TOKEN 相同
"""
from __future__ import annotations

import logging
import time
from typing import List, Optional

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import config, index_store, media
from .engine import get_engine, l2

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("catcampus")

# 余弦相似度 → 0~99 分的映射区间。
#
# 这两个数字不是拍脑袋定的，是用真实猫照片实测标定的（tools/_realcat_probe.py）：
#     同一只猫 + 旋转/翻转变换 : 0.960 ~ 0.996
#     不同猫之间              : 0.745 ~ 0.926
#     猫 vs 完全无关的图片     : 0.509 ~ 0.551
# 取 SIM_LOW=0.70（略高于无关图上限）让噪声彻底归零，
# 取 SIM_HIGH=0.96（略低于同猫下限）让“确凿匹配”拿满分。
# 早期版本用 0.40/0.85，导致任意两只猫都打满 99 分 —— 检索形同失效。
# 余弦 → 展示分的映射区间（v2=CLS 特征下按 scripts/probe_pool_preprocess.py 实测校准）：
# CLS 特征的实测分布：不同猫（类间）≤ ~0.76，同一只猫不同构图（类内）~0.78-0.85，同一张图 1.0。
# 取 SIM_LOW=0.75（略高于类间上限）让不同猫的分数归零，
# 取 SIM_HIGH=0.90（类内中上段）让"确凿匹配"拿满分 —— 禁止再出现 99%/97% 贴脸。
SIM_LOW = 0.75
SIM_HIGH = 0.90

# Top1 与次名的相似度差小于该值时，认为“分不出来”，压低置信度而不是硬判。
# v2=CLS 特征下类内-类间天然间隔约 0.1（实测），0.05 取其一半作为「拉不开差距」线
GAP_CLEAR = 0.05

app = FastAPI(title="CatCampus Vision", version="1.0.0")


# ---------------- 鉴权 ----------------
def authorize(authorization: str = Header(default="")) -> None:
    # ⚠️ 空 token 绝不能「对外开放」：识别服务多为公网可达的云托管实例，
    # 未配 token 等于任何人都能调 build-index 清空特征库、白嫖推理算力。
    # 早期写法 `if not config.API_TOKEN: return` 正是这个洞。
    if not config.API_TOKEN:
        raise HTTPException(status_code=503, detail="服务未配置 API_TOKEN（请在环境变量中设置）")
    if authorization != f"Bearer {config.API_TOKEN}":
        raise HTTPException(status_code=401, detail="invalid token")


# ---------------- 数据模型 ----------------
class CatRef(BaseModel):
    id: str
    name: str = ""
    pattern: str = ""
    color: str = ""
    photos: List[str] = Field(default_factory=list)   # 必须是可直接下载的 https 临时链接


class RecognizeReq(BaseModel):
    url: str = ""                 # 主图（图片走这条）
    videoUrl: str = ""            # 视频本体链接，用于真抽帧
    fileId: str = ""
    type: str = "image"
    frames: int = 1
    schoolId: str = ""
    cats: List[CatRef] = Field(default_factory=list)


class EmbedReq(BaseModel):
    url: str
    detect: bool = True


# ---------------- 工具 ----------------
def to_grade(sim: float) -> int:
    """把余弦相似度压成 0~99 的展示分。
    必须先判 finite：NaN 是 truthy，max/min 都拦不住，
    round(NaN)=NaN → int(NaN) 抛 ValueError，整个识别请求 500。"""
    if not np.isfinite(sim):
        return 0
    v = (sim - SIM_LOW) / (SIM_HIGH - SIM_LOW) * 100
    return int(max(0.0, min(99.0, round(v))))


def _ensure_index_inner(cats: List[CatRef], school_id: str, limit: int,
                        skip_ids: Optional[set] = None) -> None:
    eng = get_engine()
    built = 0
    for c in cats:
        if built >= limit:
            break
        if not c.photos:
            continue
        if skip_ids and c.id in skip_ids:
            continue   # 本次识别自己带的那只：照片刚下载过，别重复下
        if index_store.get(c.id) is not None:
            continue
        im = media.fetch_image(c.photos[0])
        if im is None:
            continue
        emb, _, _, _, _ = eng.features(im)
        index_store.put(c.id, school_id, emb, source="bootstrap")
        built += 1
    if built:
        log.info("冷启动补库 %d 只", built)


def ensure_index(cats: List[CatRef], school_id: str, limit: int = 40,
                 skip_ids: Optional[set] = None) -> None:
    """冷启动补库：本地特征库里没有的猫，用 Payload 带来的照片链接算出来并保存。

    限流的目的是防止首次上线时被 200 只猫的下载请求拖垮；跑过一次 /v1/index/build 之后
    基本不会走到这里。

    补库是「尽力而为」的副作用：任何异常都只记日志，绝不能让一次识别请求 500。
    skip_ids：本次识别自己带照片的那只猫（照片刚下过，别重复下）。
    """
    try:
        _ensure_index_inner(cats, school_id, limit, skip_ids)
    except Exception as e:  # noqa: BLE001 —— 见 docstring
        log.error("冷启动补库失败（本次识别可能缺少候选）: %s: %s", type(e).__name__, e)


def index_health(school_id: str = "") -> dict:
    """特征库健康快照：后端异常不冒泡，降级成字段返回。

    特征库是**可再生数据**，它挂了不该让整个接口 500 ——
    健康检查 500 会被平台判成实例不健康、反复重启，故障反而更难查。
    降级约定：indexed = -1 表示取不到，indexError 带原因。
    """
    try:
        return {"indexed": index_store.count(school_id),
                "indexBackend": index_store.BACKEND_NAME}
    except Exception as e:  # noqa: BLE001 —— 见 docstring
        err = "%s: %s" % (type(e).__name__, e)
        log.error("特征库后端不可用（识别将无候选）: %s", err)
        return {"indexed": -1, "indexBackend": index_store.BACKEND_NAME, "indexError": err}


def search(query: np.ndarray, cats: List[CatRef], school_id: str, top_n: int = 5):
    try:
        bank = index_store.load(school_id)
    except Exception as e:  # noqa: BLE001 —— 特征库挂了只降级为「无候选」
        log.error("特征库读取失败，本次检索无候选: %s: %s", type(e).__name__, e)
        return []
    if not bank:
        return []

    ids = list(bank.keys())
    vecs = [np.asarray(bank[i], dtype=np.float32).reshape(-1) for i in ids]
    if not vecs:
        return []
    # 维度一致性：更换/调整 ReID 模型、或建库中途部分猫失败残留旧向量时，
    # np.stack 会抛 "all input arrays must have the same shape" → 识别全 500。
    # 这里按多数维度过滤不匹配项并告警，保证服务不塌。
    dim = vecs[0].shape[0]
    if any(v.shape[0] != dim for v in vecs):
        kept = [(i, v) for i, v in zip(ids, vecs) if v.shape[0] == dim]
        log.warning("特征库维度不一致：保留 %d/%d 条（dim=%d）", len(kept), len(ids), dim)
        if not kept:
            return []
        ids = [i for i, _ in kept]
        vecs = [v for _, v in kept]
    q = np.asarray(query, dtype=np.float32).reshape(-1)
    if q.shape[0] != dim:
        log.warning("查询向量维度 %d 与特征库 %d 不一致，本次检索跳过", q.shape[0], dim)
        return []

    mat = np.stack(vecs)                                  # [N, D]
    q = q.reshape(1, -1)
    sims = (mat @ q.T).reshape(-1)                        # 向量已 L2 归一化，点积即余弦
    sims = np.nan_to_num(sims, nan=0.0, posinf=0.0, neginf=0.0)   # 脏向量不污染排序

    name_by_id = {c.id: c.name for c in cats}
    photo_by_id = {c.id: (c.photos[0] if c.photos else "") for c in cats}

    order = np.argsort(-sims)[:top_n]
    out = []
    for rank, i in enumerate(order):
        cid = ids[i]
        s = float(sims[i])
        score = to_grade(s)

        # Top1 若与次名拉不开差距，说明这几只猫在当前图上长得一样，
        # 压低分数让上层走“人工确认”，而不是给个高分误导用户直接点确认。
        if rank == 0 and len(order) > 1:
            gap = s - float(sims[order[1]])
            if gap < GAP_CLEAR:
                score = int(score * (0.5 + 0.5 * max(0.0, gap) / GAP_CLEAR))

        out.append({
            "catId": cid,
            "name": name_by_id.get(cid, ""),
            "avatar": photo_by_id.get(cid, ""),
            "score": score,
            "rawSim": round(s, 4),
            "reason": f"特征相似度 {s * 100:.1f}%",
        })
    return out


# ---------------- 接口 ----------------
@app.get("/health")
def health():
    eng = get_engine()
    return {
        "ok": True,
        "provider": eng.provider,
        "dim": eng.dim,
        "ffmpeg": media.ffmpeg_ok(),
        **index_health(),   # indexed / indexBackend，异常时降级为 indexed=-1 + indexError
    }


@app.post("/v1/recognize")
def recognize(req: RecognizeReq, _=Depends(authorize)):
    t0 = time.time()
    eng = get_engine()
    if not req.url and not req.videoUrl:
        raise HTTPException(status_code=400, detail="url or videoUrl required")

    n_frames = max(1, min(config.MAX_FRAMES, int(req.frames or 1)))
    frames: List = []

    if req.type == "video" and req.videoUrl and media.ffmpeg_ok():
        frames = media.extract_frames(req.videoUrl, n_frames)
        log.info("抽帧 %d 张", len(frames))

    if not frames:
        im = media.fetch_image(req.url)
        frames = [im] if im is not None else []

    if not frames:
        raise HTTPException(status_code=502, detail="素材下载失败")

    # 补库放在提特征之前、且只补「本次没带的猫」：
    # 请求里带的照片（第 1 帧那张）刚下载过，补库若再下一遍就是纯浪费一次网络往返
    # （实测日志里同一 URL 出现两次 GET、整条链路多 ~1s）。带 skip_ids 后
    # 补库只处理其它猫，命中缓存也能省一次下载。
    ensure_index(req.cats, req.schoolId, skip_ids={req.cats[0].id} if req.cats else None)

    # 逐帧提特征后做平均再归一化 —— 比单帧稳定，尤其视频里猫会动会糊
    embs, color, pattern, conf, detected = [], "", "", 0.0, False
    for im in frames:
        e, c, p, cf, det = eng.features(im)
        embs.append(e)
        if c and not color:
            color = c
        if p and not pattern:
            pattern, conf = p, cf
        detected = detected or det

    query = l2(np.mean(np.stack(embs), axis=0))
    candidates = search(query, req.cats, req.schoolId)

    tags = []
    if color:
        tags.append({"k": "毛色", "v": color})
    if pattern:
        tags.append({"k": "花纹", "v": pattern})
    tags.append({"k": "检测", "v": "已定位猫体" if detected else "整图"})
    tags.append({"k": "帧数", "v": str(len(frames))})

    return {
        "features": {
            "tags": tags,
            "pattern": pattern,
            "color": color,
            "size": "",
            "confidence": round(float(conf or 0.75), 3),
            "embedding": query.astype(float).tolist(),
        },
        "candidates": candidates,
        "meta": {
            "provider": eng.provider,
            "frames": len(frames),
            "latency": int((time.time() - t0) * 1000),
            **index_health(req.schoolId),
        },
    }


@app.post("/v1/embed")
def embed(req: EmbedReq, _=Depends(authorize)):
    """单独抽向量，供建库脚本 / 调试用。"""
    im = media.fetch_image(req.url)
    if im is None:
        raise HTTPException(status_code=502, detail="图片下载失败")
    e, c, p, cf, det = get_engine().features(im)
    return {"embedding": e.astype(float).tolist(), "dim": int(e.shape[0]),
            "color": c, "pattern": p, "detected": det}


class BuildReq(BaseModel):
    schoolId: str = ""
    cats: List[CatRef] = Field(default_factory=list)
    photosPerCat: int = 6
    # 只补「特征库里还没有」的猫。定时任务 / 识别热路径增量补库传 true：
    # 已入库的猫直接跳过，既不重复下载也不重算，整批几乎零开销。
    onlyMissing: bool = False
    # 强制重算（手动「全量重建」时用），优先级高于 onlyMissing。
    force: bool = False


@app.post("/v1/index/build")
def build(req: BuildReq, _=Depends(authorize)):
    """批量建库：把档案里每只猫的若干张照片平均成一个「代表向量」存起来。

    多张照片平均出来的代表向量比单张稳得多 —— 同一只猫正面 / 侧面 / 光线差异会被抹平一部分。

    onlyMissing=True 时幂等：特征库里已有向量的猫整只跳过（连照片都不下载），
    所以每天跑一次定时全量建库的成本 ≈ 只建当天新增的猫。
    """
    eng = get_engine()
    ok, fail, skipped = 0, [], 0
    for c in req.cats:
        if req.onlyMissing and not req.force and index_store.get(c.id) is not None:
            skipped += 1
            continue
        embs = []
        for u in c.photos[: max(1, req.photosPerCat)]:
            im = media.fetch_image(u)
            if im is None:
                continue
            e, _, _, _, _ = eng.features(im)
            embs.append(e)
        if not embs:
            fail.append(c.id)
            continue
        rep = l2(np.mean(np.stack(embs), axis=0))
        index_store.put(c.id, req.schoolId, rep, source="build")
        ok += 1
    return {
        "ok": True, "built": ok, "failed": fail, "skipped": skipped,
        "total": index_store.count(req.schoolId),
    }


@app.delete("/v1/index")
def clear_index(schoolId: str = "", _=Depends(authorize)):
    """清空特征库（整体重建前调用）。

    schoolId 为空清空全部；否则只清该校区。配合 /v1/index/build 可实现
    「档案库即真相来源」——新增 / 改名 / 删猫后整体同步一次即完全一致。
    """
    removed = index_store.clear(schoolId)
    return {"ok": True, "removed": removed, "remaining": index_store.count(schoolId)}
