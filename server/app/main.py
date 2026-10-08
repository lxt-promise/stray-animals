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
SIM_LOW = 0.70
SIM_HIGH = 0.96

# Top1 与次名的相似度差小于该值时，认为“分不出来”，压低置信度而不是硬判
GAP_CLEAR = 0.03

app = FastAPI(title="CatCampus Vision", version="1.0.0")


# ---------------- 鉴权 ----------------
def authorize(authorization: str = Header(default="")) -> None:
    if not config.API_TOKEN:
        return  # 未配置 token 时对外开放，仅限内网调试
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
    """把余弦相似度压成 0~99 的展示分。"""
    v = (sim - SIM_LOW) / (SIM_HIGH - SIM_LOW) * 100
    return int(max(0.0, min(99.0, round(v))))


def ensure_index(cats: List[CatRef], school_id: str, limit: int = 40) -> None:
    """冷启动补库：本地特征库里没有的猫，用 Payload 带来的照片链接算出来并保存。

    限流的目的是防止首次上线时被 200 只猫的下载请求拖垮；跑过一次 /v1/index/build 之后
    基本不会走到这里。
    """
    eng = get_engine()
    built = 0
    for c in cats:
        if built >= limit:
            break
        if not c.photos or index_store.get(c.id) is not None:
            continue
        im = media.fetch_image(c.photos[0])
        if im is None:
            continue
        emb, _, _, _, _ = eng.features(im)
        index_store.put(c.id, school_id, emb, source="bootstrap")
        built += 1
    if built:
        log.info("冷启动补库 %d 只", built)


def search(query: np.ndarray, cats: List[CatRef], school_id: str, top_n: int = 5):
    bank = index_store.load(school_id)
    if not bank:
        return []

    ids = list(bank.keys())
    mat = np.stack([bank[i] for i in ids])              # [N, D]
    query = query.reshape(1, -1)
    sims = (mat @ query.T).reshape(-1)                  # 向量已 L2 归一化，点积即余弦

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
        "indexed": index_store.count(),
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
    ensure_index(req.cats, req.schoolId)
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
            "indexed": index_store.count(req.schoolId),
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


@app.post("/v1/index/build")
def build(req: BuildReq, _=Depends(authorize)):
    """批量建库：把档案里每只猫的若干张照片平均成一个「代表向量」存起来。

    多张照片平均出来的代表向量比单张稳得多 —— 同一只猫正面 / 侧面 / 光线差异会被抹平一部分。
    """
    eng = get_engine()
    ok, fail = 0, []
    for c in req.cats:
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
    return {"ok": True, "built": ok, "failed": fail, "total": index_store.count(req.schoolId)}


@app.delete("/v1/index")
def clear_index(schoolId: str = "", _=Depends(authorize)):
    """清空特征库（整体重建前调用）。

    schoolId 为空清空全部；否则只清该校区。配合 /v1/index/build 可实现
    「档案库即真相来源」——新增 / 改名 / 删猫后整体同步一次即完全一致。
    """
    removed = index_store.clear(schoolId)
    return {"ok": True, "removed": removed, "remaining": index_store.count(schoolId)}
