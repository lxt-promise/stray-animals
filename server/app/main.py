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
import math
import os
import time
from typing import List, Optional

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import config, index_store, media, recocache
from . import attrs as attr_labels
from .engine import get_engine, l2, rep_vector

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("catcampus")

# 余弦相似度 → 0~99 分的映射：**logistic 校准**，参数在 config（SIM_MID / SIM_SLOPE）。
#
# 这里原来是一个线性窗口（0.75~0.90 拉伸到 0~99），历史注释解释了它为什么是 0.75/0.90：
# 按「同一张图做旋转翻转 0.96~0.996、不同猫 0.745~0.926」实测标定。
# 但那组数据是**同一张照片做变换**测出来的，天花板高得离谱；
# 真实场景是「同一只猫、另一张照片、另一个背景」，2026-10-24 现场值是 0.763 ——
# 于是展示分 9%，用户以为识别坏了，而排序其实是对的。
#
# 换 logistic 的理由：真实分布里「同猫」和「异猫」是两坨大面积重叠的云，
# 没有一条能一刀切干净的线。硬窗口在这条线上判死的，恰恰是边缘的真匹配；
# logistic 只是把「有多像」连续地折成「有多少把握」，不再制造死区。
SIM_LOW = 0.75      # 保留名字供旧调用方/文档引用；实际映射用 config.SIM_MID
SIM_HIGH = 0.90

# Top1 与次名的相似度差小于该值时，认为“分不出来”，压低置信度而不是硬判。
GAP_CLEAR = config.GAP_CLEAR

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
    # 缓存排队耐心（毫秒）：同一个素材已有请求在算时，本次最多等它多久。
    # 云函数按自己的 AI 窗口填（poll 路径约 1.5s）。0 = 不等，立刻返回排队中。
    # 有了它，「第一个请求还在算」就不会退化成「每个请求都自己算一遍」。
    waitMs: int = 0


class EmbedReq(BaseModel):
    url: str
    detect: bool = True


# ---------------- 工具 ----------------
def to_grade(sim: float) -> int:
    """把余弦相似度折成 0~99 的展示分（logistic，参数见 config.SIM_MID 的推导）。

    必须先判 finite：NaN 是 truthy，max/min 都拦不住，
    round(NaN)=NaN → int(NaN) 抛 ValueError，整个识别请求 500。

    单调性是这个函数唯一的硬约束：分数可以被人质疑地高或低，但**不能出现
    「更像的排后面」**。历史上换成任何非线性映射都要保住这条，否则前端
    按分数重排（vision.js 里 `.sort((a,b)=>b.score-a.score)`）会打乱检索顺序。
    """
    if not np.isfinite(sim):
        return 0
    mid = float(config.SIM_MID)
    k = float(config.SIM_SLOPE) or 1.0
    z = (float(sim) - mid) * k
    # exp 溢出保护：|z| 到 30 时两端已经是 0 / 99，再大只是浮点噪音（OverflowError）
    z = max(-30.0, min(30.0, z))
    v = 99.0 / (1.0 + math.exp(-z))
    return int(max(0, min(int(config.SCORE_CAP), round(v))))


def _dominant(reasons: List[str]) -> str:
    """取出现次数最多的原因码（并列时取先出现的）。

    一只猫有多张照片时失败原因可能混着（2 张过期 + 1 张文件没了），
    展示给用户要挑最有代表性的那个 —— 它是「下一步做什么」的依据。
    """
    if not reasons:
        return "unknown"
    order, count = [], {}
    for r in reasons:
        if r not in count:
            count[r] = 0
            order.append(r)
        count[r] += 1
    best = order[0]
    for r in order[1:]:
        if count[r] > count[best]:
            best = r
    return best


def _ensure_index_inner(cats: List[CatRef], school_id: str, limit: int,
                        skip_ids: Optional[set] = None,
                        budget_ms: int = 0) -> int:
    """冷启动补库，返回本次真正入库的猫数。

    ⚠️ 只有「带 photos 的猫」才会被建库（`if not c.photos: continue`）。
    云函数默认只送轻量 cats（不带 photos），所以正常档案的向量要靠
    `/v1/index/build` 或识别热路径的 pendingPhotos 增量补。

    ⚠️ budget_ms > 0 时是**硬预算**：每建一只就检查剩余时间，超了立刻收工返回。
    这个参数是为识别热路径准备的 —— 云函数给 AI 的窗口只有 1800ms，
    一次请求如果顺手补十几只猫（每只下载 15s 超时上限 + 推理），
    会把整个响应拖到几十秒（现场实测 78s），云函数必然超时降级。
    补库是「锦上添花」，绝不能拖垮当次识别 —— 没补完的下次接着补，幂等。
    """
    eng = get_engine()
    deadline = (time.time() + budget_ms / 1000.0) if budget_ms > 0 else None
    built = 0
    for c in cats:
        if built >= limit:
            break
        if not c.photos:
            continue
        if skip_ids and c.id in skip_ids:
            continue
        if deadline is not None and time.time() >= deadline:
            log.info("补库预算用尽（已建 %d 只），剩余交给下次/定时任务", built)
            break
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
    return built


def ensure_index(cats: List[CatRef], school_id: str, limit: int = 40,
                 skip_ids: Optional[set] = None, budget_ms: int = 0) -> int:
    """冷启动补库：本地特征库里没有的猫，用 Payload 带来的照片链接算出来并保存。

    限流的目的是防止首次上线时被 200 只猫的下载请求拖垮；跑过一次 /v1/index/build 之后
    基本不会走到这里。

    补库是「尽力而为」的副作用：任何异常都只记日志，绝不能让一次识别请求 500。
    skip_ids：**不要传「本次识别的那只猫」** —— req.cats 是按全库顺序排的，
    cats[0] 跟本次上传的照片无关。早期这么传过，结果全库第一只猫永远补不进库。
    budget_ms：识别热路径传一个硬预算（见 _ensure_index_inner 的注释）。
    """
    try:
        return _ensure_index_inner(cats, school_id, limit, skip_ids, budget_ms)
    except Exception as e:  # noqa: BLE001 —— 见 docstring
        log.error("冷启动补库失败（本次识别可能缺少候选）: %s: %s", type(e).__name__, e)
        return 0


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


def _attr_agree(qcolor: str, cat_pattern: str) -> Optional[bool]:
    """花色是否相容：True / False / None（没信息）。见 attrs.compatible。"""
    if not qcolor:
        return None
    ok = attr_labels.compatible(qcolor, cat_pattern)
    return ok


def search(query: np.ndarray, cats: List[CatRef], school_id: str,
           top_n: Optional[int] = None, attrs: Optional[dict] = None):
    """特征库检索。返回 (候选列表, 诊断信息)。

    ⚠️ 诊断信息里的 `indexed` / `ids` 是**上游必须消费**的，不是调试附赠品：
    云函数用它决定「哪些猫可以标记为已入库」（见 vision.js markIndexed）。
    早期只在识别成功后无条件标记全部——服务端补库失败时那些猫被误标，
    从此再也不会送照片，向量永久缺失，表现就是「库里有 4 只猫但只能认出 1 只」。

    候选过滤：**原始余弦**低于 config.MIN_SIM 的猫直接丢弃。
    没有阈值时，库里只有 1 只猫就必然返回那 1 只（哪怕 0%），
    界面会把它当 Top1 结论展示 —— 这是「上传白猫返回小黑」的直接成因。

    attrs：本次识别出的属性（color/pattern/confidence）。给了就用花色做**平局破局**
    （见 config.ATTR_RERANK，默认关闭，原因写在那里）。
    评分口径：`rawSim` 是纯余弦，`score` 由它（加上平局折算）折出 —— 两者同源，
    界面上「原始相似度 x%」与右侧大数字的关系是可解释的。

    top_n 省略时取 config.TOP_N。**必须显式 None 判断而不是 `or 默认值`**：
    `or` 会把合法的 0 顶成默认值（项目里踩过多次，服务端 ATTR_EXPOSURE_GAIN=0
    就是这么被吞掉的，导致对照组静默失效）。
    """
    k = int(top_n) if top_n is not None and int(top_n) > 0 else int(config.TOP_N)
    info = {"indexed": 0, "ids": [], "dropped": 0, "bankReadError": "", "reranked": 0}
    try:
        bank = index_store.load(school_id)
    except Exception as e:  # noqa: BLE001 —— 特征库挂了只降级为「无候选」
        log.error("特征库读取失败，本次检索无候选: %s: %s", type(e).__name__, e)
        info["bankReadError"] = "%s: %s" % (type(e).__name__, e)
        return [], info
    if not bank:
        return [], info

    ids = list(bank.keys())
    info["indexed"] = len(ids)
    info["ids"] = ids
    vecs = [np.asarray(bank[i], dtype=np.float32).reshape(-1) for i in ids]
    if not vecs:
        return [], info
    # 维度一致性：更换/调整 ReID 模型、或建库中途部分猫失败残留旧向量时，
    # np.stack 会抛 "all input arrays must have the same shape" → 识别全 500。
    # 这里按多数维度过滤不匹配项并告警，保证服务不塌。
    dim = vecs[0].shape[0]
    if any(v.shape[0] != dim for v in vecs):
        kept = [(i, v) for i, v in zip(ids, vecs) if v.shape[0] == dim]
        log.warning("特征库维度不一致：保留 %d/%d 条（dim=%d）", len(kept), len(ids), dim)
        if not kept:
            return [], info
        ids = [i for i, _ in kept]
        vecs = [v for _, v in kept]
        info["ids"] = ids
        info["indexed"] = len(ids)
    q = np.asarray(query, dtype=np.float32).reshape(-1)
    if q.shape[0] != dim:
        log.warning("查询向量维度 %d 与特征库 %d 不一致，本次检索跳过", q.shape[0], dim)
        return [], info

    mat = np.stack(vecs)                                  # [N, D]
    q = q.reshape(1, -1)
    raw = (mat @ q.T).reshape(-1)                         # 向量已 L2 归一化，点积即余弦
    raw = np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)   # 脏向量不污染排序

    name_by_id = {c.id: c.name for c in cats}
    photo_by_id = {c.id: (c.photos[0] if c.photos else "") for c in cats}
    pattern_by_id = {c.id: c.pattern for c in cats}

    # 查询花色：conf 达门槛才算「判出来了」，否则当没信息（不过滤、不破平）。
    qcolor = ""
    if attrs and float(attrs.get("confidence") or 0) >= float(config.ATTR_RERANK_MIN_CONF):
        qcolor = str(attrs.get("color") or "")

    # 先按阈值筛，再排序 —— 否则边界候选占满 top_n，把真正像的挤出去。
    # 阈值一律看**原始余弦**：花色只负责破平，不该把低于门槛的猫拉进候选。
    #
    # 花色硬过滤（2026-10-24）：与查询花色「物理不可能」的档案直接出局。
    # 只用 attrs.HARD_EXCLUSIVE（黑白系 × 橘/三花/玳瑁），不用软相容表的
    # False —— 后者会连 gray/tabby 一起挡，而黑白误判成灰/狸花是启发式
    # 踩过的坑，硬过滤会把正确档案剔光（详见 config.ATTR_FILTER 注释）。
    # 档案 pattern 为空 / other / 不在枚举时 hard_exclusive 一律 False，保守放行。
    attr_dropped = 0
    if config.ATTR_FILTER and qcolor:
        kept = []
        for i in np.argsort(-raw):
            if float(raw[i]) < config.MIN_SIM:
                continue
            if attr_labels.hard_exclusive(qcolor, pattern_by_id.get(ids[i], "")):
                attr_dropped += 1
                continue
            kept.append(i)
            if len(kept) >= k:
                break
        order = kept
    else:
        order = [i for i in np.argsort(-raw) if float(raw[i]) >= config.MIN_SIM][:k]
    info["dropped"] = len(ids) - len(order) if len(order) < len(ids) else 0
    if attr_dropped:
        info["attrDropped"] = attr_dropped
        log.info("花色硬过滤剔除 %d 只（查询=%s）", attr_dropped, qcolor)

    # 花色破平：只在「头名集团」内部换名次，且必须显式开启（见 config.ATTR_RERANK）。
    # 关键限制是 ATTR_TIE_BAND —— 只有余弦差本来就小于它的几只猫才允许被重排，
    # 于是花色最多回答「这两只分不出来时选谁」，永远不会把明显更像的猫挤下去。
    # （qcolor 已在阈值筛选阶段算好，硬过滤与破平共用同一个置信门槛。）
    if config.ATTR_RERANK and qcolor and len(order) > 1:
        top_sim = float(raw[order[0]])
        band = [i for i in order if float(raw[i]) >= top_sim - float(config.ATTR_TIE_BAND)]
        if len(band) > 1:
            def _key(i):
                # 相容(True) 排最前，没信息(None) 居中，冲突(False) 垫底；同组按余弦
                agree = _attr_agree(qcolor, pattern_by_id.get(ids[i], ""))
                rank_v = 0 if agree is True else (1 if agree is None else 2)
                return (rank_v, -float(raw[i]))
            new_band = sorted(band, key=_key)
            if new_band != band:
                info["reranked"] = len(band)
                order = new_band + order[len(band):]

    out = []
    lead = 0.0
    if len(order) > 1:
        lead = float(raw[order[0]] - raw[order[1]])
    for rank, i in enumerate(order):
        cid = ids[i]
        s_raw = float(raw[i])
        score = to_grade(s_raw)

        # Top1 若与次名拉不开差距，说明这几只猫在当前图上长得一样，
        # 压低分数让上层走“人工确认”，而不是给个高分误导用户直接点确认。
        # 折算系数从 0.5 提到 GAP_FLOOR(0.75)：0.05 的差距在 0.76 附近就是噪声，
        # 砍半会把一次真匹配从 56 分打到 28 分，反而更像「没识别出来」。
        if rank == 0 and len(order) > 1:
            gap = s_raw - float(raw[order[1]])
            if gap < GAP_CLEAR:
                score = int(round(score * (config.GAP_FLOOR
                                           + (1.0 - config.GAP_FLOOR)
                                           * max(0.0, gap) / GAP_CLEAR)))

        item = {
            "catId": cid,
            "name": name_by_id.get(cid, ""),
            "avatar": photo_by_id.get(cid, ""),
            "score": score,
            "rawSim": round(s_raw, 4),
            "reason": f"特征相似度 {s_raw * 100:.1f}%",
        }
        # Top1 带一个「领先次名多少」：用户看到 56% 会怀疑，但配上
        # 「原始相似度 76.3% · 领先次名 6.5%」就能看懂——分数低是因为
        # 模型本身只敢给这么高，而排序是清楚的。
        if rank == 0 and len(order) > 1:
            item["lead"] = round(lead, 4)
        # 花色是否一致，仅作诊断（前端暂不展示，排查「为什么 A 排在 B 前面」时看）
        if qcolor:
            item["attrMatch"] = _attr_agree(qcolor, pattern_by_id.get(cid, ""))
        out.append(item)
    return out, info


# ---------------- 接口 ----------------
@app.get("/health")
def health(schoolId: str = ""):
    """健康检查 / 部署自查。

    除了「服务活着」，这里要能回答现场最常问的三个问题：
      ① 特征库里到底有几只猫（indexed）—— 库里只有 1 只时，识别必然永远返回那 1 只；
      ② 猫体检测有没有启用（detector）—— 没启用就是整图提特征，背景会污染向量；
      ③ 毛色/花纹属性走的是哪条路（attrSource）—— clip 最准、heuristic 是本地
         色域分析的兜底。attrs 为 false 只代表「CLIP 没开」，**花色照样有**，
         因为启用了启发式（2026-10-17 起）。
    这四个字段直接对应「识别不准」的几大成因，排查时不用翻代码。

    schoolId：传了则 `indexed` 只统计该校（管理后台的口径），
    同时给 `indexedTotal`（全库）。两者不同是正常的：特征库按校隔离，
    全库还会包含其它学校 + 已删档案的残留向量 —— 但**两个数字混着一个口径**
    会让管理员以为「档案 6 只怎么库里有 11 只」出了灵异事件（2026-10-25 现场）。
    """
    eng = get_engine()
    det = getattr(eng.detector, "path", "") or ""
    scoped = index_health(schoolId)
    total = index_health()
    return {
        "ok": True,
        "provider": eng.provider,
        "dim": eng.dim,
        "size": eng.embedder.size,          # 模型实际接受的输入边长（可能与配置不同）
        "detector": bool(eng.detector.sess),
        # 检测模型用的是哪个文件（自动发现还是显式配置）、阈值、外扩比例。
        # 「detector=true 但框得不准」时，先确认这里指向的是不是预期的那份权重。
        "detectModel": os.path.basename(det) if det else "",
        "detectSize": getattr(eng.detector, "size", 0),
        "detectConf": config.DETECT_CONF,
        "detectPad": config.DETECT_PAD,
        "attrs": bool(eng.clf.ok),
        "attrSource": eng.attr_source,      # clip / api / heuristic —— 属性实际来源
        "minSim": config.MIN_SIM,
        "identifyMin": config.IDENTIFY_MIN,
        # 校准曲线参数：现场「为什么同一只猫只有 56%」时，先看这两个数是不是
        # 被环境变量改过（SIM_MID 越大越严格 / SIM_SLOPE 越大越陡）。
        "simMid": config.SIM_MID,
        "simSlope": config.SIM_SLOPE,
        "attrRerank": bool(config.ATTR_RERANK),
        "framesMax": config.MAX_FRAMES,
        "ffmpeg": media.ffmpeg_ok(),
        # 识别结果缓存：`cached` 是当前缓存条数，`computing` 是正在计算的条数。
        # 排查「同一个素材被反复识别」时先看它 —— 缓存为 0 而识别很慢，
        # 说明要么 TTL=0 关掉了，要么多实例部署导致各缓存一份。
        **recocache.stats(),
        # indexed：带 schoolId 时按校计（管理后台口径）；indexedTotal 恒为全库。
        # 后台「特征库 N 只」与「花色比对卡本校 N 条」以前各说各话，
        # 就是这里没分口径 —— 现在两个数一起下发，差值一眼可解释。
        **scoped,                                            # indexed / indexBackend
        "indexedTotal": total.get("indexed", -1),            # 全库（含其它学校/残留）
        "indexedScoped": bool(schoolId),                     # indexed 是否按校过滤
    }


@app.post("/v1/recognize")
def recognize(req: RecognizeReq, _=Depends(authorize)):
    """识别入口。外面这层只负责**缓存**，真正的活儿在 _recognize_run。

    缓存的必要性（2026-10-25 现场日志）：一段 6 秒视频在一分钟内被算了 10 次，
    每次 3.5s，最后一次都没用上 —— 因为云函数 poll 路径只能给 AI 1.8s，
    窗口注定算不完，每轮从头再算、结果全丢，重试耗尽后降级本地引擎。
    缓存让「第二次调用直接拿到第一次的结果」，视频才能在第二轮轮询里成功。
    详见 app/recocache.py 的模块注释。
    """
    if not req.url and not req.videoUrl:
        raise HTTPException(status_code=400, detail="url or videoUrl required")

    n_frames = max(1, min(config.MAX_FRAMES, int(req.frames or 1)))
    if config.RECO_CACHE_TTL <= 0:
        return _recognize_run(req, n_frames, cached=False)

    key = recocache.cache_key(req.type, req.url, req.videoUrl, n_frames, req.schoolId)
    t_wait = time.time()
    result, cached = recocache.get_or_compute(
        key, config.RECO_CACHE_TTL, config.RECO_CACHE_MAX,
        lambda: _recognize_run(req, n_frames, cached=False),
        wait_ms=max(0, int(req.waitMs or 0)),
    )
    if result is None:
        # 别人还在算，自己又等不起了。返回 503 让云函数按超时处理、下轮再来
        # （那时大概率已命中缓存）。不能改成分数/空结果 —— 那会被当成真结论。
        log.info("识别排队中：%.0fms 内没等到前一次计算（key=%s）",
                 (time.time() - t_wait) * 1000, key[:8])
        raise HTTPException(status_code=503, detail="识别排队中，请稍后重试")

    if cached:
        # 只 shallow-copy 一层再补字段：缓存里的对象是所有请求共享的，
        # 直接改会把「首次耗时/是否缓存」写进缓存，后面的请求全读到脏数据。
        result = dict(result)
        meta = dict(result.get("meta") or {})
        meta["cached"] = True
        meta["waitMs"] = int((time.time() - t_wait) * 1000)
        result["meta"] = meta
    return result


def _recognize_run(req: RecognizeReq, n_frames: int, cached: bool):
    """一次完整的识别。被 recognize 直接调用，或作为缓存未命中时的计算体。"""
    t0 = time.time()
    eng = get_engine()
    frames: List = []

    if req.type == "video" and req.videoUrl and media.ffmpeg_ok():
        frames = media.extract_frames(req.videoUrl, n_frames)
        log.info("抽帧 %d 张", len(frames))

    if not frames:
        im = media.fetch_image(req.url)
        frames = [im] if im is not None else []

    if not frames:
        raise HTTPException(status_code=502, detail="素材下载失败")

    # 补库放在提特征之前。**不传 skip_ids** —— 早期传的是 req.cats[0].id，
    # 而 req.cats 是「全库猫列表」，第 0 只跟本次上传的照片毫无关系；
    # 结果全库第一只猫永远被跳过、永远补不进库。
    # 幂等由 _ensure_index_inner 里的 index_store.get(c.id) 保证，不需要额外跳过。
    #
    # ⚠️ 硬预算 + 限量：云函数给识别接口的窗口只有 ~1.8s（见 vision.js 的
    # AI_POLL_CAP_MS）。早期这里 limit=40 且不限时，一次请求顺手补十几只猫
    # （每只一次图片下载，超时上限 15s），响应被拖到几十秒 —— 现场实测 78s，
    # 云函数侧必然超时、重试、最终降级本地引擎，用户看到的就是「识别不准」。
    # 现在：最多补 2 只、最多 1.2s，没补完的下次接着补（幂等）。
    t_boot = time.time()
    built_now = ensure_index(
        [c for c in req.cats if c.photos],   # 只对本次真带了照片的猫动手
        req.schoolId,
        limit=int(os.getenv("BOOTSTRAP_LIMIT", "2")),
        budget_ms=int(os.getenv("BOOTSTRAP_BUDGET_MS", "1200")),
    )
    boot_ms = int((time.time() - t_boot) * 1000)

    # 检测 + 提取 + 花色，三步都在 engine.analyze_frames 里：
    #   检测只跑一次（多帧复用同一个框）、逐帧提特征后平均再归一化、
    #   花色取置信度最高的那一帧。为什么这么切，见 analyze_frames 的 docstring。
    # 放在这里调用而不是内联，是为了让「每帧都检测」这类退化能被单测抓住 ——
    # 它不会报错，只会悄悄多花 N×65ms 并让多帧平均失去意义。
    analysis = eng.analyze_frames(frames)
    embs, detected = analysis["embs"], analysis["detected"]
    embed_ms = analysis["timing"]["embed"]
    detect_ms = analysis["timing"]["detect"]

    # 查询图质量门控（2026-10-26）：猫在画面里占比太小 → 特征不足，
    # 此时**不出候选、花色也弃权**。硬给一个错误候选比说"看不清"更糟：
    # 用户会照着错候选点「就是这只猫」，把错样本写进特征库，污染是永久的。
    # 实测依据见 engine._quality 的 docstring（夜间白猫 4.9% 时与橘猫档案
    # 相似度 63.8% 反超与白猫档案的 61.5%）。
    quality = analysis.get("quality") or {"ok": True, "areaRatio": 0.0, "reason": ""}
    quality_ok = bool(quality.get("ok"))

    attrs = analysis["attr"] or {
        "color": "", "pattern": "", "breed": "", "confidence": 0.0,
        "source": "", "palette": [], "stripe": 0.0,
        "reason": "画面里没有可用于判断花色的区域",
    }
    if not quality_ok:
        # 小目标下色域统计同样不可信（框里背景占比高），花色一并弃权，
        # 否则会用错误花色去过滤候选 / 展示给用户。
        attrs = {
            "color": "", "pattern": "", "breed": "", "confidence": 0.0,
            "source": "", "palette": [], "stripe": 0.0,
            "reason": quality.get("reason") or "照片质量不足，未判定花色",
        }
    color, pattern = attrs["color"], attrs["pattern"]

    # 多帧聚合用 rep_vector 而不是裸 mean：视频里总有糊帧/侧身帧，
    # 平均值对离群点没有抵抗力（一帧糊掉会把整条查询向量拽偏）。
    # 帧数少（1~2）时它等价于平均，见 engine.rep_vector。
    #
    # ⚠️ spread_min=0.0 显式关掉「离散度高就退回 medoid」：那条规则是拿
    # **建档照**实测出来的（tools/mv_eval.py），查询侧没有对应数据。
    # 视频帧数多（最多 8），一旦触发就从「内点平均」退化成「单帧」，
    # 对查询是有害的 —— 建档侧要抗离群，查询侧要充分利用所有帧，诉求不同。
    query = rep_vector(embs, spread_min=0.0)
    t_search = time.time()
    # 把花色一起交给检索：花色是独立于像素相似度的证据（见 search 的 _attr_shift）
    if quality_ok:
        candidates, sinfo = search(query, req.cats, req.schoolId, attrs=attrs)
    else:
        # 质量不达标就不检索：库里的猫会轮流出场当"最像的一只"，
        # 而真相是"这张照片谁都不像"。
        candidates, sinfo = [], {
            "indexed": 0, "ids": [], "dropped": 0, "bankReadError": "",
            "reranked": 0, "qualitySkipped": True,
        }
    search_ms = int((time.time() - t_search) * 1000)

    tags = []
    # 品种（花色类型）放最前：它是「一眼看到的结论」，毛色/花纹是拆解。
    # 三个值各自走对应的中文表：color 用前端枚举的中文（纯白/橘猫/三花…），
    # pattern 用纹理的中文（虎斑条纹/纯色…）—— 混用会导致界面出现 "solid"。
    if attrs["breed"]:
        tags.append({"k": "品种", "v": attrs["breed"]})
    if color:
        tags.append({"k": "毛色", "v": attr_labels.COLOR_LABELS.get(color, color)})
    if pattern:
        tags.append({"k": "花纹", "v": attr_labels.PATTERN_LABELS.get(pattern, pattern)})
    # 「整图」不是中性信息：它意味着没做猫体裁剪，背景会污染特征向量，
    # 这时结果的可信度明显低于「已定位猫体」。措辞要把这层风险带出去。
    tags.append({"k": "检测", "v": "已定位猫体" if detected else "整图（未裁剪）"})
    tags.append({"k": "帧数", "v": str(len(frames))})

    # 属性（毛色/花纹）现在恒可用：CLIP 没开会落到 app/attrs.py 的色域分析。
    # attrs_ready 保留旧语义（CLIP 是否启用），attr_source 说明实际走的哪条路，
    # 排查时能区分「模型判的」和「数像素算的」。
    attrs_ready = bool(eng.clf.ok)

    # 身份是否认得出来。低于 IDENTIFY_MIN（默认 45 分 ≈ 余弦 0.745）时前端把文案从
    # 「这是某某」改成「没认出来，但看起来是……」，属性照常展示 ——
    # 这正是「没识别上就调特征识别」这个需求的落点。
    identified = bool(candidates) and candidates[0]["score"] >= config.IDENTIFY_MIN

    total_ms = int((time.time() - t0) * 1000)
    # 分段耗时进日志：现场排查「为什么这个请求 78 秒」时，只有总耗时等于没信息。
    # 五个数字一眼就能定位是补库下载、检测、模型推理、还是特征库读取卡住。
    # 末尾带上花色结论与来源，排查"上传白猫判成橘"时不用再翻响应体。
    log.info("/v1/recognize %dms（补库%d/%dms 检测%dms 推理%dms 检索%dms 帧%d 候选%d 库%d）"
             " 检测=%s 花色=%s/%s(%s %.2f)%s | Top1=%s",
             total_ms, built_now, boot_ms, detect_ms, embed_ms, search_ms,
             len(frames), len(candidates), sinfo["indexed"],
             ("%s@%.2f" % (analysis["box"], analysis["detectConf"])) if detected
             else ("未框到：" + (analysis["detectReason"] or "未知")),
             color or "-", pattern or "-", attrs["source"] or "-", attrs["confidence"],
             " 未采信：" + attrs["reason"] if attrs["reason"] else "",
             # 一行看清「原始余弦 → 展示分」的换算结果，校准时不用重跑请求
             ("%s 原始%.3f→%d分%s" % (
                 candidates[0]["name"] or candidates[0]["catId"],
                 candidates[0]["rawSim"], candidates[0]["score"],
                 " 花色不符" if candidates[0].get("attrMatch") is False else ""))
             if candidates else "无候选")

    return {
        "features": {
            "tags": tags,
            "pattern": pattern,
            "color": color,
            "breed": attrs["breed"],
            "size": "",
            # 注意这是**属性置信度**（花色判得有多确定），不是身份匹配分。
            # 两者不要混：身份分在 candidates[].score。
            "confidence": round(float(attrs["confidence"] or 0), 3),
            "attrSource": attrs["source"],
            "embedding": query.astype(float).tolist(),
        },
        "candidates": candidates,
        "meta": {
            "provider": eng.provider,
            "frames": len(frames),
            "latency": total_ms,
            # 分段耗时（毫秒）—— 客户端日志里带上它，定位慢在哪一步不用翻服务端日志
            "timing": {"bootstrap": boot_ms, "detect": detect_ms,
                       "embed": embed_ms, "search": search_ms},
            # 诊断三件套（云函数必须消费 indexedIds，见 search 的 docstring）：
            "indexed": sinfo["indexed"],          # 特征库里有多少只猫
            "indexedIds": sinfo["ids"],           # 具体是哪几只 —— 云函数只标记它们
            "indexedBuilt": built_now,            # 本次请求现建了几只
            "dropped": sinfo["dropped"],          # 因相似度不足被挡掉的候选数
            "reranked": sinfo.get("reranked", 0),  # 本次因花色补偿调整过分数的猫数
            "minSim": config.MIN_SIM,
            # 身份是否认得出来：false 时前端应展示「没认出是哪只，但看起来是…」，
            # 而不是给一个 20% 的候选当结论。
            "identified": identified,
            "identifyMin": config.IDENTIFY_MIN,
            # 校准曲线也下发：前端/排查脚本可以不依赖服务端代码就复算分数
            "simMid": config.SIM_MID,
            "simSlope": config.SIM_SLOPE,
            "attrs": attrs_ready,                 # CLIP 是否启用（旧语义，保留兼容）
            "attrSource": attrs["source"],        # 实际来源：clip / api / heuristic / ''
            "attrConfidence": attrs["confidence"],
            "attrPalette": attrs["palette"],      # 各色占比，排查"为什么判成灰色"用
            "attrReason": attrs["reason"],        # 判不出来时的原因，空 = 正常
            # 查询图质量门控（2026-10-26）：false 时**候选为空是设计如此**，
            # 不是特征库空了。qualityReason 直接告诉用户该怎么做（靠近点/白天重拍）。
            "qualityOk": quality_ok,
            "qualityReason": quality.get("reason") or "",
            "areaRatio": quality.get("areaRatio", 0.0),
            # 猫体平均亮度（低光门控的输入，见 engine._box_light）：排查
            # 「为什么夜里识别被拦/花色弃权」先看它，与白天分布隔 50+。
            "lightMeanV": quality.get("lightMeanV"),
            # 曝光自适应平移量：排查「同一只猫换个光就判成另一种花色」先看它。
            # 正常照片在 ±45 内；剧烈变化说明画面曝光异常（或锚点被毛色带偏）。
            "attrShift": attrs.get("shift", 0.0),
            # 多帧聚合实际采用的启发式帧数（视频场景 >1；纯 CLIP 帧时为 0）
            "attrFrames": int(attrs.get("frames") or (1 if attrs.get("source") == "heuristic" else 0)),
            "detector": bool(eng.detector.sess),  # 猫体检测模型是否可用
            # 结果是否来自缓存。排查「日志里怎么只算了一次」时看它；
            # 也用于验证缓存是否真的在生效（视频场景应为第二轮的 True）。
            "cached": bool(cached),
            # 检测诊断：crop 用的框、检测置信度、候选框数、没框到的原因。
            # 现场「这张图明明有猫却没裁」时，看这一个字段就能分清是
            # 模型没看到（reason=模型没有识别到猫体）、框退化、还是根本没启用。
            "crop": analysis["box"],
            "detectConf": analysis["detectConf"],
            "detectCandidates": analysis["detectCandidates"],
            "detectReason": analysis["detectReason"],
            **index_health(req.schoolId),
        },
    }


@app.get("/v1/index/ids")
def index_ids(schoolId: str = "", _=Depends(authorize)):
    """列出特征库里**真实存在**的猫 id。

    管理端「哪些档案还没录入」必须查这里，不能信云库的 `cats.aiIndexAt`：
    那只是云函数侧的乐观记账，服务端补库失败时它照样有值（2026-10-17 修过这个 bug，
    但存量数据里仍有被误标的猫）。以特征库为准才能看到真相。

    特征库读不出来时返回 503，让管理端明确显示「查不到」，
    而不是返回空列表被误读成「一只都没入库」。
    """
    try:
        return {
            "ok": True,
            "ids": index_store.ids(schoolId),
            "total": index_store.count(schoolId),
            "backend": index_store.BACKEND_NAME,
        }
    except Exception as e:  # noqa: BLE001 —— 后端不可用要显式，不能伪装成空库
        err = "%s: %s" % (type(e).__name__, e)
        log.error("特征库 id 列表读取失败: %s", err)
        raise HTTPException(status_code=503, detail="特征库不可用：" + err)


@app.post("/v1/embed")
def embed(req: EmbedReq, _=Depends(authorize)):
    """单独抽向量，供建库脚本 / 调试用。"""
    im = media.fetch_image(req.url)
    if im is None:
        raise HTTPException(status_code=502, detail="图片下载失败")
    e, detected, a = get_engine().features_ex(im)
    return {"embedding": e.astype(float).tolist(), "dim": int(e.shape[0]),
            "color": a["color"], "pattern": a["pattern"], "breed": a["breed"],
            "attrSource": a["source"], "attrConfidence": a["confidence"],
            "attrPalette": a["palette"], "attrReason": a["reason"],
            "detected": detected}


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

    ⚠️ `reasons` 是**给管理端看的诊断**，不是调试附赠品：
    建库失败在云函数侧只会表现为「built=0」，管理页以前只能提示「请稍后重试」，
    而真实成因（照片没换出链接 / 下载失败 / 编码抛错）全被吞掉，管理员只能反复点按钮。
    现在每只失败的猫都带一条简短原因，前端可以直接显示出来。
    """
    eng = get_engine()
    ok, fail, skipped = 0, [], 0
    reasons = {}
    for c in req.cats:
        if req.onlyMissing and not req.force and index_store.get(c.id) is not None:
            skipped += 1
            continue
        photos = c.photos[: max(1, req.photosPerCat)]
        if not photos:
            # 没有照片 = 云函数侧换链失败或档案没照片，服务端无从下手
            fail.append(c.id)
            reasons[c.id] = "noPhoto"
            continue
        embs, dl_fail, embed_err = [], 0, ""
        dl_reasons = []
        for u in photos:
            im, why = media.fetch_image_ex(u)
            if im is None:
                dl_fail += 1
                dl_reasons.append(why or "unknown")
                continue
            try:
                e, _, _, _, _ = eng.features(im)
            except Exception as ex:  # noqa: BLE001 —— 单张编码失败不该整只猫静默失败
                embed_err = "%s: %s" % (type(ex).__name__, ex)
                log.warning("建库编码失败 cat=%s: %s", c.id, embed_err)
                continue
            if e is None:
                continue
            embs.append(e)
        if not embs:
            fail.append(c.id)
            if dl_fail >= len(photos):
                # 带上原因码：含糊的 downloadFailed 会把「临时链接过期」和
                # 「照片文件被删」混成同一件事，而后者必须让用户重新上传。
                top = _dominant(dl_reasons)
                reasons[c.id] = "downloadFailed:%s:%d/%d" % (top, dl_fail, len(photos))
            elif embed_err:
                reasons[c.id] = "embedFailed:" + embed_err[:120]
            else:
                reasons[c.id] = "noVector:%d/%d" % (dl_fail, len(photos))
            continue
        # 代表向量用 rep_vector（medoid + 内点平均）而不是裸平均：
        # 档案里混进一张糊的 / 拍错猫的照片时，纯平均会把它算进去，
        # 而这一个向量就是这只猫以后所有识别唯一的门面（见 engine.rep_vector）。
        # 走默认自适应：视图散得开时改用 medoid（REP_SPREAD_MIN，建档侧实测有效）。
        rep = rep_vector(embs)
        index_store.put(c.id, req.schoolId, rep, source="build")
        ok += 1
        if dl_fail:
            # 建成了但少用了照片：降级可接受，信息要留痕（少几张直接影响代表向量质量）
            log.info("建库降级 cat=%s 用了 %d/%d 张", c.id, len(embs), len(photos))
        elif len(embs) >= 4:
            # 多照片合成时记一条：出问题时能算出「丢了几张离群视图」
            same = sum(1 for e in embs if float(e @ rep) >= 0.9)
            if same < len(embs):
                log.info("建库合并 cat=%s %d 张里 %d 张与代表向量同族",
                         c.id, len(embs), same)
    if fail:
        log.warning("建库失败 %d 只：%s", len(fail), reasons)
    return {
        "ok": True, "built": ok, "failed": fail, "skipped": skipped,
        "reasons": reasons,
        "total": index_store.count(req.schoolId),
    }



@app.delete("/v1/index")
def clear_index(schoolId: str = "", catId: str = "", _=Depends(authorize)):
    """清空特征库（整体重建前调用）。

    schoolId 为空清空全部；否则只清该校区。配合 /v1/index/build 可实现
    「档案库即真相来源」——新增 / 改名 / 删猫后整体同步一次即完全一致。

    传了 catId 则**只删这一只**（删除猫档案时调用）。删档案不删向量的话，
    那条向量会变成幽灵残留：检索时仍被返回，只能靠云函数按 byId 过滤，
    管理页的「N 条向量」也会对不上档案数（2026-10-25 现场：6 个档案 7 条向量）。
    """
    if catId:
        removed = 1 if index_store.delete(catId) else 0
        return {"ok": True, "scope": "cat", "removed": removed,
                "remaining": index_store.count(schoolId)}
    removed = index_store.clear(schoolId)
    return {"ok": True, "scope": "school", "removed": removed,
            "remaining": index_store.count(schoolId)}
