"""轻量属性识别：毛色 / 花纹 / 花色类型（品种）。

为什么要有这个模块
------------------
CLIP 零样本分类（`config.USE_CLIP`）要装 torch + open_clip，镜像多 ~600MB，
线上为了压体积基本都没开 —— 结果 `/v1/recognize` 的 tags 里只有「检测 / 帧数」
两项，用户上传白猫看不到任何毛色信息，以为识别坏了（2026-10-17 现场问题）。

本模块用**纯 numpy + PIL** 做色域统计与条纹检测：
  - 零额外依赖（numpy / pillow 是必装项），单张图 ~5ms，CPU 随便跑；
  - 确定性输出（无随机、无采样），同一张图永远同一个结论，可回归测试；
  - 作为 CLIP 的**兜底**：CLIP 未启用、或置信度低于 `ATTR_CONF_MIN`（默认 0.5）
    时接管。

三条硬规则
----------
1. **只在猫体区域上统计**：有检测框就用框（已经紧贴猫体），没有则用中央椭圆
   压掉四角背景；背景色（草地绿、天空蓝）统一落进 `other` 桶被丢弃。
2. **不给假数据**：有效猫色像素不足 `ATTR_MIN_COVERAGE` 时返回空 + `reason`，
   绝不硬编一个"看起来还行"的颜色。这条和识别链路的降级纪律一致 ——
   伪造属性比没有属性危害大得多（用户会当真）。
3. **取值与前端枚举逐值对齐**：输出值是 `miniprogram/utils/const.js` 里
   `PATTERN` 的 value（orange / tabby / cow / calico / ...），前端可以直接
   `labelOf(C.PATTERN, value)` 渲染中文。写成服务端自创的字符串，前端就只能
   原样显示 "orange"。

可选的远程识别
--------------
配了 `ATTR_API_URL` 就走自建/公开接口（见 `_remote`），返回结构与本地一致。
未配置时完全不会发起任何网络请求 —— 默认路径是纯本地、离线可用的。
"""
from __future__ import annotations

import base64
import io
import logging
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image

from . import config

log = logging.getLogger("catcampus.attrs")

def _cfg(name: str, default: float) -> float:
    """取 config 上的数值。**绝不写 `getattr(...) or default`** —— 那会把
    合法配置的 0 / 0.0 悄悄顶成默认值（本项目踩过多次，见 _exposure_shift）。"""
    v = getattr(config, name, None)
    if v is None:
        return float(default)
    try:
        return float(v)
    except (TypeError, ValueError):
        return float(default)


# 分析分辨率：96×96 足够统计色域（9216 个样本），再大只是浪费 CPU。
_SIZE = max(32, int(_cfg("ATTR_ANALYZE_SIZE", 96)))

# 桶顺序即 np.select 的优先级 —— 靠前的先命中。
# white 在 gray/cream 之前：白猫在暖光下 S 会升到 50~60，必须先判白再判灰。
_BUCKETS = ("white", "black", "gray", "orange", "brown", "cream", "red", "other")
_OTHER = 7
_CAT_BUCKETS = _BUCKETS[:7]

# ⚠️ 这里有两个**独立维度**，早期混成一个 map 出过问题（`solid` 在前端枚举里
# 根本不存在，界面原样显示英文）：
#
#   color   = 主花色型（「这是一只什么猫」），取值必须与
#             miniprogram/utils/const.js 的 PATTERN 枚举**逐值对齐** ——
#             前端要用它回填 cats.pattern、做图鉴筛选。
#   pattern = 纹理（条纹/纯色/斑块），只用于展示，不写进档案。
COLOR_LABELS = {
    "tabby": "狸花",
    "orange": "橘猫",
    "cow": "奶牛",
    "tuxedo": "燕尾服",
    "calico": "三花",
    "tortoiseshell": "玳瑁",
    "white": "纯白",
    "black": "纯黑",
    "gray": "灰蓝",
    "siamese": "暹罗",
    "other": "其他",
}

PATTERN_LABELS = {
    "tabby": "虎斑条纹",
    "solid": "纯色",
    "cow": "黑白双色",
    "calico": "三色块",
    "tortoiseshell": "玳瑁斑",
    "pointed": "重点色",
    "spotted": "斑点",
}

# 档案花色的常见写法 → 枚举 value。
#
# 档案里的花色是人工在前端下拉里选的，理论上就是上面的 value；但现场出现过
# 中文值（「橘猫」「三花」「奶牛」）以及把**花纹标签**（「黑白双色」「三色块」）
# 误存进花色字段的情况。不归一化的话，`hard_exclusive` 的字符串比较永远是 False
# —— 属性过滤完全失效，表现就是「查询奶牛猫，候选里照样出现一只橘猫」。
# （2026-10-31 现场：三花猫匹配到「胖橘」、奶牛猫3 匹配到「胖橘」。）
_COLOR_ALIASES = {
    "橘": "orange", "橘猫": "orange", "橘色": "orange", "橙色": "orange",
    "狸花": "tabby", "狸花猫": "tabby", "虎斑": "tabby", "虎斑条纹": "tabby",
    "奶牛": "cow", "奶牛猫": "cow", "黑白": "cow", "黑白双色": "cow",
    "燕尾服": "tuxedo",
    "三花": "calico", "三花猫": "calico", "三色": "calico", "三色块": "calico",
    "玳瑁": "tortoiseshell", "玳瑁猫": "tortoiseshell", "玳瑁斑": "tortoiseshell",
    "纯白": "white", "白": "white", "纯黑": "black", "黑": "black",
    "灰": "gray", "灰蓝": "gray",
    "暹罗": "siamese", "暹罗猫": "siamese",
    "其他": "other", "其它": "other",
}


def normalize_color(value: str) -> str:
    """把档案/前端传回的花色值归一成 COLOR_LABELS 的枚举；认不出返回空串。

    空串专门表示「没有可用信息」，调用方必须按未知处理（绝不据此判死）。
    纯色/重点色/斑点这类**纹理**值没有花色语义，同样返回空串。
    """
    s = (value or "").strip().lower()
    if not s:
        return ""
    if s in COLOR_LABELS:
        return s
    return _COLOR_ALIASES.get(s, "")

# 花色「相容族」：同一个族里的两个值**可能是同一只猫**。
#
# 为什么需要它：档案里存的是人工选的单一花色（橘猫/狸花/奶牛…），
# 识别侧给出的是按色域统计的结论，两者本来就不是同一把尺子：
#   · 一只橘猫被档案记成「橘猫」，识别判成「狸花」——因为橘猫几乎都带虎斑条纹；
#   · 一只黑猫被档案记成「纯黑」，识别因为胸口白毛判成「奶牛」；
#   · 三花 / 玳瑁在色域上只差「有没有白块」。
# 直接「值相等才算一致」会把大量真匹配判成冲突，反而伤准确率。
# 跨族（橘猫 vs 奶牛）才是真正的不可能 —— 那才是冲突。
def _symmetrize(seed: dict) -> dict:
    """把「族」补成双向：a 认得 b，b 就必须认得 a。

    seed 里只写单向是**故意的**（好读：一行一件事），但查询方向的
    `compatible(a, b)` 与 `compatible(b, a)` 必须给出同一个答案 ——
    否则「A 排在 B 前面」和「B 排在 A 前面」会随参数顺序漂移，
    排查时根本没法复现。对称化只在这里做一次。
    """
    out = {k: set(v) for k, v in seed.items()}
    for a, group in seed.items():
        for b in group:
            out.setdefault(b, {b}).add(a)
    return out


COLOR_FAMILY = _symmetrize({
    "orange": {"orange", "tabby"},
    "tabby": {"tabby", "orange", "gray", "tortoiseshell"},
    "gray": {"gray", "tabby", "siamese"},
    "cow": {"cow", "tuxedo", "black"},
    "tuxedo": {"tuxedo", "cow", "black"},
    "black": {"black", "cow", "tuxedo"},
    "white": {"white"},
    "calico": {"calico", "tortoiseshell"},
    "tortoiseshell": {"tortoiseshell", "calico", "tabby"},
    "siamese": {"siamese", "gray"},
})


def compatible(a: str, b: str) -> Optional[bool]:
    """两个花色值是否「可能是同一只猫」。

    返回 True / False / **None（无从判断）**。
    None 专门留给「任一为空 / other」—— 档案没填花色、或识别判不出来时，
    任何结论都是瞎猜，调用方必须原样放过（既不奖也不罚）。
    三态而不是布尔值，是为了让「没信息」和「冲突」严格分开：
    早期若把「都没填」当 False，会给所有未标花色的档案统一减分。
    """
    a, b = normalize_color(a), normalize_color(b)
    if not a or not b or a == "other" or b == "other":
        return None
    if a == b:
        return True
    return b in COLOR_FAMILY.get(a, {a})


# 「物理不可能」的互斥对（无向存 frozenset）。只给**候选硬过滤**用。
#
# 与 COLOR_FAMILY 的职责区别：软相容表 False ≠ 敢判死。
#   cow vs gray 在软表里是 False（不同族），但黑毛反光被判灰是启发式踩过的坑
#   （见 config.ATTR_RERANK 的注释，8 张踩 2 张）—— 拿软表做硬过滤，
#   奶牛猫查询会把正确的黑猫/奶牛档案全剔掉，只剩灰猫狸花，错得更离谱。
# 敢判死的只有「色彩存在性」级矛盾：橘猫/三花/玳瑁身上**必然**有可观橘色块，
# 而黑白系猫（cow/tuxedo/black/white）一张图里长出足量橘色的唯一途径是
# 过曝泛黄 —— 这个方向历史上没有误判案例。
# 已知误判方向（黑白 → gray/tabby、白猫 → 随机）都**不在**这张表里，碰不到。
HARD_EXCLUSIVE = frozenset({
    frozenset(("cow", "orange")),
    frozenset(("tuxedo", "orange")),
    frozenset(("black", "orange")),
    frozenset(("white", "orange")),
    frozenset(("cow", "calico")),
    frozenset(("tuxedo", "calico")),
    frozenset(("black", "calico")),
    frozenset(("white", "calico")),
    # 三花 vs 纯橘：三花必然同时有黑块和白块，档案若标「橘猫」说明不是同一只。
    # （2026-10-31：三花幼猫查询时「胖橘」排在 97%，档案花色标注决定了这条能否命中）
    frozenset(("calico", "orange")),
    frozenset(("cow", "tortoiseshell")),
    frozenset(("tuxedo", "tortoiseshell")),
    frozenset(("white", "tortoiseshell")),
})


def hard_exclusive(a: str, b: str) -> bool:
    """两个花色是否「物理不可能是同一只猫」—— 比 compatible 更强的结论。

    任一为空 / other / 认不出 → False（绝不判死，保守放行）。
    注意方向无关：hard_exclusive(a, b) == hard_exclusive(b, a)。
    两侧都先 normalize_color：档案里存中文（「三花」「奶牛」）时也能命中。
    """
    a, b = normalize_color(a), normalize_color(b)
    if not a or not b or a == "other" or b == "other":
        return False
    return frozenset((a, b)) in HARD_EXCLUSIVE

# 色桶（统计用的内部分类）→ 中文，只出现在 palette 里
_BUCKET_LABELS = {
    "white": "白", "black": "黑", "gray": "灰", "orange": "橘",
    "brown": "深棕", "cream": "米黄", "red": "红棕",
}


def _empty(reason: str = "", refused: bool = False, **extra) -> dict:
    """判不出来时的空结果。

    refused=True 表示**素材本身不可用**（糊片 / 猫体几乎不存在），不是
    「颜色不集中」这种算法层面的判不出。上层据此**不再拿低置信 CLIP 结果
    兜底** —— 素材不可用时任何模型结论都不可信，必须让用户重拍。
    """
    out = {
        "color": "",
        "pattern": "",
        "breed": "",
        "confidence": 0.0,
        "source": "heuristic",
        "palette": [],
        "stripe": 0.0,
        "reason": reason,
        "refused": refused,
    }
    out.update(extra)
    return out


def _mask_array(mask) -> Optional[np.ndarray]:
    """把外部掩膜统一成「原尺寸、0~1 浮点」。坏掩膜返回 None（跳过门控）。"""
    if mask is None:
        return None
    try:
        m = np.asarray(mask, dtype=np.float32)
        if m.ndim > 2:
            m = m[..., 0]
        if m.ndim != 2 or m.size == 0:
            return None
        if float(m.max()) > 1.0 + 1e-3:
            m = m / 255.0
        return np.clip(m, 0.0, 1.0)
    except Exception:        # noqa: BLE001
        return None


def _sharpness(rgb: Image.Image, mask: Optional[np.ndarray]) -> Optional[float]:
    """前景区域的清晰度：Laplacian 响应的方差（512 长边口径）。

    为什么必须在**前景**上算、且在 512 而不是 96：96×96 缩略图会把失焦/运动
    模糊几乎全部抹掉（实测同一张图人工模糊 r=4，96px 口径下分数只掉 10%），
    而背景（墙、地板、床单）的纹理又和猫毛无关，整图口径会把一张糊猫照
    抬成「清晰」。512 是「还能看到毛发边缘」和「大图 CPU 开销」的折中：
    实测（34 张真实素材，见 config.ATTR_MIN_SHARP 的注释）可用照片
    13~2300，人工模糊 r=6 后 1~3，两簇之间空得很开。

    返回 None = 算不出来（掩膜坏 / 图太小），此时门控不生效 —— 宁可放过，
    不要因为度量失败误拦正常照片。
    """
    if mask is None:
        return None
    try:
        size = max(64, int(_cfg("ATTR_SHARP_SIZE", 512)))
        w, h = rgb.size
        s = size / float(max(w, h))
        im = rgb if s >= 1.0 else rgb.resize(
            (max(1, int(round(w * s))), max(1, int(round(h * s)))), Image.BILINEAR)
        g = np.asarray(im.convert("L"), dtype=np.float32)
        if g.shape[0] < 3 or g.shape[1] < 3:
            return None
        lap = np.abs(4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1]
                     - g[1:-1, :-2] - g[1:-1, 2:])
        mm = _mask_array(mask)
        if mm is None:
            return None
        if mm.shape[:2] != g.shape:
            mm = np.asarray(Image.fromarray((mm * 255).astype(np.uint8)).resize(
                (g.shape[1], g.shape[0]), Image.BILINEAR), dtype=np.float32) / 255.0
        fg = mm[1:-1, 1:-1] >= _cfg("MATTING_ALPHA_THR", 0.5)
        if int(fg.sum()) < 500:
            return None
        return float(lap[fg].var())
    except Exception as e:   # noqa: BLE001 —— 度量失败不拦识别，见 docstring
        log.warning("清晰度度量失败，跳过质量门控：%s: %s", type(e).__name__, e)
        return None


def _quality_gate(rgb: Image.Image, mask: Optional[np.ndarray]) -> dict:
    """照片「能不能用来判断花色」的前置检查。

    只回答可用性，不碰花色。目前两条**保守下限**（阈值推导见
    config.ATTR_QUALITY_GATE 的注释）：

      ① 前景占比：掩膜确认的猫体像素不足 0.5% —— 猫被完全挡住/掩膜失败；
      ② 清晰度：512 口径 Laplacian 方差 < 20 —— 糊到看不出毛发边界。

    没有掩膜时直接放行（`analyze` 的合成图单测也不传掩膜）。这是有意的：
    质量度量需要前景，拿整图算会把背景纹理当成「清晰度」。
    """
    if not bool(getattr(config, "ATTR_QUALITY_GATE", True)):
        return {"ok": True, "reason": "", "sharp": None, "fg": None}
    if mask is None:
        return {"ok": True, "reason": "", "sharp": None, "fg": None}

    mm = _mask_array(mask)
    if mm is None:
        return {"ok": True, "reason": "", "sharp": None, "fg": None}
    fg = float((mm >= _cfg("MATTING_ALPHA_THR", 0.5)).mean())
    if fg < _cfg("ATTR_MIN_FG", 0.005):
        return {"ok": False, "fg": round(fg, 4), "sharp": None,
                "reason": "画面里几乎找不到猫体（前景只占 %.1f%%），可能被遮挡、"
                          "糊掉或太暗，请让猫完整清晰地入镜后重拍" % (100.0 * fg)}
    sharp = _sharpness(rgb, mask)
    if sharp is not None and sharp < _cfg("ATTR_MIN_SHARP", 10.0):
        return {"ok": False, "fg": round(fg, 4), "sharp": round(sharp, 1),
                "reason": "照片偏模糊（清晰度 %d，需要 %d 以上），毛色细节看不清，"
                          "请对准猫、保持对焦后重拍"
                          % (int(round(sharp)), int(round(_cfg("ATTR_MIN_SHARP", 10.0))))}
    return {"ok": True, "reason": "", "fg": round(fg, 4),
            "sharp": None if sharp is None else round(sharp, 1)}


def _center_weight(w: int, h: int) -> np.ndarray:
    """中心加权图（中心 1，边缘 ~0.44，四角 ~0.17）。

    为什么不用硬椭圆 mask：椭圆对「边缘中点」几乎不起作用 —— 一条贴着画面左右
    边框的背景（很常见的构图）在椭圆里权重仍然是 1，背景照样污染统计。改成
    连续降权后，边缘和角落的影响力是平滑衰减的，四角真能压到 ~17%。

    ⚠️ 只有**整图**模式才加权。检测框裁出的 crop 已经紧贴猫体，
    再压边缘会把耳朵和尾巴的权重一起削掉。
    """
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    sx, sy = max(1.0, (w - 1) * 0.40), max(1.0, (h - 1) * 0.40)
    d = ((xx - cx) / sx) ** 2 + ((yy - cy) / sy) ** 2
    return np.exp(-0.5 * d)


def _wquantile(values: np.ndarray, weights: np.ndarray, p: float) -> float:
    """加权分位数。整图模式下边缘被降权，直接 np.percentile 会被四角背景带偏。"""
    v = np.asarray(values, dtype=np.float64).ravel()
    w = np.asarray(weights, dtype=np.float64).ravel()
    if v.size == 0:
        return 0.0
    if w.size != v.size or float(w.sum()) <= 0:
        return float(np.percentile(v, p * 100.0))
    order = np.argsort(v, kind="stable")
    vs, ws = v[order], w[order]
    cw = np.cumsum(ws)
    return float(vs[min(vs.size - 1, int(np.searchsorted(cw, cw[-1] * p)))])


def _exposure_shift(v: np.ndarray, weight: np.ndarray,
                    s: Optional[np.ndarray] = None) -> float:
    """估计画面曝光偏差，返回**所有 V 阈值要整体平移的量**。

    为什么需要它（2026-10-25）：色桶里有 4 条分界线是**绝对亮度**：
    white/gray 界 175、black 界 62、橘棕界 130。而现场照片的曝光天差地别
    （正午草地 vs 傍晚树荫），同一只猫只改亮度就会整桶搬家 —— 实测
    `_cats.jpeg` 左上那只黑白猫，white 占比从 0.6× 的 0.000 一路涨到
    1.4× 的 0.363：暗光下白毛全掉进灰桶，结论从「奶牛」变成「纯黑」。

    锚点选 **V 的 98 分位**（而非中位数）：中位数会被「猫本身是黑/白」带偏
    （纯黑猫的中位数天然很低，照它平移会把黑猫抬成灰猫），而 p98 反映的是
    「画面里最亮的那部分有多亮」—— 主要来自高光与环境光，与猫的毛色
    基本无关。实测同一亮度下四只不同花色的猫 p98 相差不到 25 级，
    而亮度 0.6×→1.4× 时 p98 从 120 涨到 255，是干净的曝光信号。

    平移而非缩放：缩放会压缩色桶之间的相对关系，把「灰」挤成「白」；
    整体平移保持各桶间距不变，只把整条亮度轴对齐到标准曝光。

    眩光防护（2026-10-28，传了 s 才生效）：夜间点光源 / 强反光像素
    （V≥ATTR_GLARE_V 且 S≤ATTR_GLARE_S）会把 p98 顶到 240+，让严重欠曝的
    夜景误判成「曝光正常」—— 实测夜间白猫照 p98=242 全被一盏灯占据，
    锚点失效，白毛（V 92~184）整桶掉进 gray/black。把这些像素从锚点统计里
    剔除后再取 p98；眩光质量占比过半时放弃剔除（那说明画面主体就是白亮
    区域，比如白天的白猫 —— 剔了反而没锚点）。
    """
    p_hi = _wquantile(v, weight, 0.98)
    if s is not None:
        gv = _cfg("ATTR_GLARE_V", 248.0)
        gs = _cfg("ATTR_GLARE_S", 35.0)
        glare = (v >= gv) & (s <= gs)
        w2 = weight * (~glare)
        total = float(weight.sum())
        if total > 0 and float(w2.sum()) > 0.5 * total:
            p_hi = _wquantile(v, w2, 0.98)
    # ⚠️ 这三个必须用「显式 None 判断」取值：`x or 默认值` 会把合法的 0 顶掉
    # （ATTR_EXPOSURE_GAIN=0 本意是「关闭自适应」，用 or 会变成 0.6 照旧生效，
    #  现场排查时表现为「环境变量明明配了却没变化」）。项目里这条踩过多次。
    ref = _cfg("ATTR_EXPOSURE_REF", 210.0)
    gain = _cfg("ATTR_EXPOSURE_GAIN", 0.6)
    cap = _cfg("ATTR_EXPOSURE_MAX", 45.0)
    if not np.isfinite(p_hi):
        return 0.0
    return float(max(-cap, min(cap, (p_hi - ref) * gain)))


def _classify(hd: np.ndarray, s: np.ndarray, v: np.ndarray,
              shift: float = 0.0) -> np.ndarray:
    """逐像素归类到 8 个桶。hd 是度数 0~360，s/v 是 0~255（PIL 的 HSV 口径）。

    阈值是按「猫毛的典型 RGB」定的，不是通用调色板：
      橘猫毛 (222,152,84)   → S≈158 V≈222 H≈29  → orange
      白猫毛 (238,235,228)  → S≈14  V≈238        → white
      黑猫毛 (46,44,42)     → V≈46               → black
      灰猫毛 (150,152,156)  → S≈10  V≈156        → gray
      狸花底毛(152,132,100) → S≈87  V≈152 H≈36   → cream（浅黄褐）

    `shift` 是曝光自适应平移量（见 _exposure_shift），所有**亮度**阈值一起加减它。
    注意 S 和 H 不动：HSV 里 S=(max-min)/max 是比值、H 是色相角度，
    两者对整体亮度**天然免疫**，只有 V 会漂 —— 所以只平移 V 是精确的。

    ⚠️ white 分界只平移 **半个** shift：p98 锚点在「单色中间调猫」（灰猫）上
    会被毛色本身带低（灰猫的高光就是它的毛），此时下调 white 阈值会把灰判成白
    —— 实测纯灰 (150,152,156) 判成 white。减半后灰猫保住（156 < 175-16），
    而暗光白毛本就靠 light = white + (gray - dgray) 的「亮灰并入浅色」兜底，
    不依赖 white 门槛全幅下移。
    """
    w_hi = 175.0 + 0.5 * shift              # white 下界 / gray 上界（半幅）
    b_hi = 62.0 + shift                     # black 上界 / gray 下界
    o_v = 130.0 + shift                     # 鲜明橘(亮) 与 深棕(暗) 的分界
    red_v = float(min(120.0, max(30.0, 70.0 + shift)))   # 红棕，门槛低，别被平移带飞

    white = (v >= w_hi) & (s <= 55)
    black = v <= b_hi
    gray = (s <= 45) & (v > b_hi) & (v < w_hi)
    orange = (s >= 105) & (v >= o_v) & (hd >= 5) & (hd <= 48)
    brown = (s >= 50) & (v < o_v) & (hd >= 5) & (hd <= 55)
    cream = (s >= 50) & (v >= o_v) & (hd >= 25) & (hd <= 65)
    red = (s >= 100) & (v >= red_v) & ((hd >= 335) | (hd <= 8))
    # np.select 按列表顺序取**第一个**成立的，天然互斥，不用手写 else-if 链
    return np.select(
        [white, black, gray, orange, brown, cream, red],
        list(range(len(_CAT_BUCKETS))),
        default=_OTHER,
    )


def _stripe_score(gray: np.ndarray) -> float:
    """条纹显著度 0~1（频率法）：条纹 = 沿主方向**周期性交替**的明暗带。

    旧版只看梯度方向性，但黑白斑块（奶牛猫）的边界同样是强单向梯度 ——
    实测 8 张真实猫照里 4 张奶牛全部误报（stripe 0.36~0.65），直接导致
    奶牛猫判不成奶牛（两色调规则要求 not has_tabby）。

    条纹与斑块的本质区别是**重复次数**：虎斑有 5 条以上明暗带，
    斑块边界只有 1~3 条。所以改成数「去趋势轮廓的交替带数」：
      1. 梯度方向性定主方向（顺带挡掉各向同性噪点）；
      2. 沿主方向取逐行/列轮廓，减去低频（窗口≈1/8 边长）；
      3. 数符号交变次数 → 交替带数；带数多 + 调制深 → 条纹显著。

    实测标定（8 张真实猫照，server/tools/real_sim_eval.py 同一批素材）：
      狸花：周期 11~12、调制 0.63+ → 得分 0.9+
      奶牛斑块：周期 7~9、调制 0.34~0.55 → 得分 ≤0.55
      纯色：0；随机噪点：方向性比值 ~1，被第一步压到 0.25 以下
    """
    g = np.asarray(gray, dtype=np.float32)
    if g.ndim != 2 or g.shape[0] < 4 or g.shape[1] < 4:
        return 0.0
    ex = float(np.abs(np.diff(g, axis=1)).mean())   # 沿 x 变化 → 竖条纹
    ey = float(np.abs(np.diff(g, axis=0)).mean())   # 沿 y 变化 → 横条纹
    hi, lo = (ex, ey) if ex >= ey else (ey, ex)
    ratio = hi / (lo + 1e-6)
    energy = min(1.0, hi / 14.0)                    # 14 个灰度级已算"看得见"
    if ratio < 1.15:
        # 各向同性 → 不是条纹（噪点图两方向都大但相等）。留小权重防误杀。
        return round(0.25 * energy, 3)

    # 主方向上的 1D 轮廓：竖条纹按行看（每行都是一条条纹序列）
    rows = g if ex >= ey else g.T
    n = rows.shape[1]
    k = max(4, n // 8)                              # 低频窗口 ≈ 条纹宽度的量级
    kernel = np.ones(k, dtype=np.float32) / k
    counts, mods = [], []
    for row in rows[::4]:                           # 采样 1/4 行足够稳定，省 CPU
        if row.size < 2 * k + 2:
            continue
        r = row - np.convolve(row, kernel, mode="same")
        r = r[k:-k]                                 # 卷积两端有边界效应，裁掉
        if r.size < 4:
            continue
        crossings = int(np.sum(np.diff(np.sign(r)) != 0))
        counts.append(crossings / 2.0)              # 交变次数 ≈ 2×条带数
        # 调制深度：去趋势残差占整行对比度的比例。纯噪点的残差≈自身 → 被带数筛掉
        mods.append(float(r.std()) / (float(row.std()) + 1e-6))
    if not counts:
        return 0.0
    # counts 是「明暗整周期数」（一次交变 = 一条亮带 + 一条暗带）。
    # 实测标定（8 张真实猫照 + 合成条纹）：狸花 11+ 周期、调制 0.63+；
    # 合成条纹 6 周期、调制 0.99；奶牛斑块 7~9 周期但调制只有 0.34~0.55。
    # 分母取 9、再乘调制：合成条纹 0.67×0.99≈0.66、真狸花 ≥0.9 都过线；
    # 奶牛斑块 ≤0.55、三花斑块 ≤0.46、橘猫 ≈0.45 都够不着 —— 调制深度
    # 是斑块与条纹的第二道分界（斑块明暗对比不均匀）。
    bands = float(np.median(counts))
    mod = float(np.median(mods))
    if bands < 2:
        return round(0.25 * energy, 3)
    periodic = min(1.0, bands / 9.0)
    return round(float(min(1.0, periodic) * min(1.0, mod / 0.65)), 3)


def _breed_of(color: str, pattern: str) -> str:
    """花色类型（民间说的"品种"）。

    这是**外貌归类**，不是血统鉴定 —— 靠颜色和条纹判断不了英短/布偶，
    硬猜只会误导。用「橘狸花」「黑白奶牛猫」这类描述既准确又是用户真正想要的。
    """
    return {
        "calico": "三花猫",
        "tortoiseshell": "玳瑁猫",
        "cow": "黑白奶牛猫",
        "tuxedo": "燕尾服猫",
        "siamese": "重点色猫",
        "white": "白猫",
        "black": "黑猫",
        "gray": "灰猫",
        "orange": "橘狸花" if pattern == "tabby" else "橘猫",
        "tabby": "狸花猫",
        "other": "",
    }.get(color, "")


def _decide(ratio: dict, stripe: float, dgray: float = 0.0,
            warmish: Optional[float] = None,
            bright: Optional[float] = None,
            sat: Optional[float] = None,
            pale: Optional[float] = None) -> tuple:
    """颜色占比 + 条纹 → (color, pattern)。全是枚举 value。

    dgray = 「暗灰」占比（62 < 亮度 ≤125 的低饱和像素），2026-10-24 新增。
    为什么需要：黑毛在阳光/灯光下反光，亮度落到 60~120，被 _classify 归进
    gray 桶 —— 实测一张奶牛猫照 gray 桶 51%（其中暗灰 28%），黑只占 21%，
    两色调规则（white/black 双门槛）永远够不着，最后判成「灰猫」。
    判定用**有效暗色 dark = black + dgray**、**有效浅色 light = white + 亮灰**，
    原 ratio 只留给 palette 展示。

    warmish = 「暖色系像素」占比（H 5~55、S≥50，**不限亮度**），2026-10-26 新增。
    与 ratio 里的 brown/cream 桶的区别：桶有 V 门槛，夜间 V 一塌全都掉进
    black/black 之前的桶里；而 S 和 H 对整体亮度**天然免疫**（见 _classify
    的注释），warmish 是夜里唯一可靠的暖色证据。**None = 没有这项证据 →
    相关门槛不生效**（保守放行，保持旧判定）—— 绝不把「没测」当「0」处理，
    那会让所有没传 warmish 的调用方一夜之间判不出狸花。

    bright / sat = 前景（抠图后猫毛）的「亮毛占比」与平均饱和度，2026-10-31
    新增（见 _stats_of）。只有**抠图模式**才会提供；None = 没有这项证据，
    夜间白猫救援（规则 8b）不生效 —— 不拿含背景的统计冒充猫毛亮度。

    pale = 「暖白」占比（V≥175 且 S 55~80、H 20~70），2026-10-31 新增。
    暖光/室内灯把白毛的 S 从 ~20 染到 56~79，`_classify` 只收 S≤55 的 white，
    于是这部分白毛掉进 cream 桶，三花判定（要 white≥0.28）永远够不着。
    只在三花规则里并入 white（white_like），**不参与**白猫/奶牛等单色判定 ——
    否则浅色墙/床单会把 white 抬到 0.5 以上，把普通猫判成白猫。
    """
    white = ratio["white"]
    black = ratio["black"]
    gray = ratio["gray"]
    orange = ratio["orange"]
    brown = ratio["brown"]
    cream = ratio["cream"]
    red = ratio["red"]

    dark = black + dgray                                        # 黑毛 + 反光黑毛
    light = white + max(0.0, gray - dgray)                      # 白毛 + 亮灰（阴影里的白毛）
    # 三花判定用的「白」：纯白 + 暖光把白毛染成的暖白（见 pale 的注释）。
    # 只在下面规则 1 / 2b 用，单色与奶牛规则仍用严格 white。
    white_like = white + (float(pale) if pale is not None else 0.0)
    # ⚠️ red **不**计入暖色（2026-10-25）。
    # 理由是场景先验：真正的红棕色猫极少见（家猫红棕基本就是深橘，落 orange/brown），
    # 而**红色杂物**极常见 —— 渔网、红布、砖墙、红毯、塑料袋，而且经常就在猫旁边
    # 甚至盖在猫身上（检测框裁不掉）。实测一张「白猫坐红渔网」的照片 red 桶 0.30+，
    # warm 被抬到 0.45+，硬生生判成橘猫；同一只猫没渔网就判对。red 留在 palette
    # 里做诊断展示，但不再参与任何判定规则 —— 少一类暖色结论，
    # 换掉「旁边有红色东西就判橘」这个高频灾难，划算。
    warm = orange + brown + cream           # 暖色（橘/棕/奶黄）总量
    has_tabby = stripe >= config.ATTR_STRIPE_MIN
    # 弱条纹带（2026-10-28 新增，实测狸花猫棚拍照 stripe=0.56 差线）：
    # 条纹分卡在 [0.5, 门槛) 的图，要求**更强的暖色证据**（warmish≥0.25）
    # 才认狸花 —— 真狸花底毛的暖色证据通常 0.3+；而条纹分虚高的奶牛猫
    # （斑块边界有方向性，实测 0.52）warmish 只有 0.01~0.09，进不来。
    # warmish=None（没这项证据）时弱带不生效，保守退回旧行为。
    # 🔴 2026-11-05：灰底狸花（银虎斑/树荫下的棕灰狸花）warmish 只有 0.058，
    # 条纹 0.59 又差一点到 0.60，两头都够不着 —— 实测「狸花猫2」被判成纯白。
    # 与规则 7 同源的证据「有效浅色 light≥0.15」（中等亮度毛多、而纯黑/纯白
    # 都不满足）同样成立，所以弱带接受这条替代路径。
    # ⚠️ 必须定义在**所有规则之前**：玳瑁规则也要用它（玳瑁的红黑斑块同样
    # 会产生周期性梯度，不能因为它 stripe 高就排掉）。
    weak_tabby = (not has_tabby and stripe >= config.ATTR_TABBY_WEAK_STRIPE and
                  warmish is not None and
                  (warmish >= config.ATTR_TABBY_WEAK_WARM or light >= 0.15))
    tabby_like = "tabby" if (has_tabby or weak_tabby) else "solid"

    # 1) 三花（严格）：白 + 鲜明橘 + 黑三色共存。warm 设上限是因为橘猫的
    #    warm 总量更高（0.53+），靠下限挡不住「白胸橘猫」。
    #    2026-10-31 修（实测「三花猫」实拍判成「橘狸花」）：
    #    · 白用 white_like（含暖白）—— 暖光下白肚皮 white 只有 0.18，
    #      严格 white≥0.28 永远够不着；加暖白后 0.23，门槛落到 0.22。
    #    · warm 上限 0.50 → 0.65：实拍图里**手掌**也进了掩膜，皮肤是暖色，
    #      把 warm 抬到 0.56。真橘猫 warm 0.65~0.92，仍被上界挡在外面。
    #    · dark 下限 0.03 → 0.06：三花必有黑块；放宽白之后用它挡住
    #      「橘白猫 + 阴影」凑出来的假三色（橘猫实测 dark 0.01~0.02）。
    if (white_like >= 0.22 and 0.15 <= warm <= 0.65 and
            dark >= 0.06 and orange >= 0.08):
        return "calico", "calico"
    # 2) 玳瑁：暗色 + 暖色、几乎没有白，且暖色里**红/奶油块**占比高。
    #    2026-10-31 重写：旧版靠「没有规则条纹」区分狸花，但抠图后实测玳瑁的
    #    不规则红黑斑块 stripe 0.69、狸花猫1 只有 0.56 —— 条纹在这两者间
    #    完全不可靠。改成看暖色的**构成**：玳瑁的红棕/奶油块（orange+cream）
    #    占暖色总量 0.21~0.25，狸花以棕黄褐底毛为主（0.07）。
    #    weak_tabby 的狸花（stripe 0.5~0.6）必须排除，否则会被这条抢先。
    warm_red = (orange + cream) / warm if warm > 1e-6 else 0.0
    if dark >= 0.18 and warm >= 0.18 and light < 0.12 and not weak_tabby:
        if not has_tabby:
            # 没有规则条纹：色域上就是玳瑁的不规则斑块（旧规则口径）
            return "tortoiseshell", "tortoiseshell"
        if config.ATTR_TORTOISE_RED_SHARE <= warm_red <= config.ATTR_TORTOISE_RED_SHARE_MAX:
            # 条纹分过线，但暖色构成是「红/奶油块 + 深棕黑毛」（玳瑁）。
            # 奶油/黑条纹的狸花底毛图 warm_red 接近 1（整身暖色都是奶油），
            # 会被上界挡在门外，落到规则 6/7 判狸花。
            return "tortoiseshell", "tortoiseshell"
    # 2b) 三花·白背景稀释救援（2026-10-28）：棚拍白背景占总像素六成以上时，
    #     真三花的鲜明橘被稀释到 0.02~0.05，规则 1/4 的橘门槛永远够不着，
    #     最终落到规则 8 判「纯白」—— 实测两张三花棚拍照（orange 0.03、
    #     white 0.61/0.71）都如此。救援条件必须**四条同时成立**：
    #     white≥0.50（稀释才可能发生）+ orange≥0.02（挡乳橘猫案例 0.003）+
    #     dark≥0.05（真三花必有黑块；挡只有阴影的橘白猫）+ warm≥0.14（同规则4）。
    #     放在奶牛规则之前：满足这四条的「白底照」橘块是真实猫毛，不是杂物。
    if (white >= 0.50 and warm >= 0.14 and
            orange >= config.ATTR_CALICO_LOOSE_ORANGE and
            dark >= config.ATTR_CALICO_LOOSE_DARK):
        return "calico", "calico"
    # 3a) 黑白两色调·遮挡救援（2026-11-05）：人手/红袖等**连在猫身上的前景**
    #     会被 u2netp 一起抠进来（实测「奶牛猫4」掩膜把整条手臂算成猫体），
    #     皮肤是暖色，把 warmish 顶到 0.376 > 闸值 0.34、brown 顶到 0.169 > 0.15，
    #     真奶牛被规则 3 挡在门外，最后落到单色规则判成「纯白」。
    #     这里改用**不依赖暖色**的中性证据：白毛够多 + 有真黑块 + 灰不占主导。
    #     真黑块（black 桶 V≤62）比 dgray（阴影/反光）可靠；灰上界挡「白猫+阴影」
    #     把 gray 堆高的情况；orange 上界保证真有橘块的三花先被规则 1/2b 接走。
    #     条纹上界是关键：棚拍白背景的狸花同样是「白+黑+低灰」（white 0.48 /
    #     black 0.30 / stripe 0.56），没有它会被这条救援规则吞成奶牛。
    #     必须放在规则 3 之前、2c 之前（否则被遮挡的奶牛会先命中 2c 判成三花）。
    if (white >= 0.30 and black >= 0.08 and orange < 0.08 and
            stripe < config.ATTR_TABBY_WEAK_STRIPE and
            light >= 0.30 and dark >= 0.16 and gray < config.ATTR_COW_MAX_GRAY):
        return ("cow" if light >= 0.22 else "tuxedo"), "cow"
    # 2c) 白身三花·局部斑块（2026-11-05）：白身猫的橘/黑块只长在头和尾巴上，
    #     全局 orange 只有 0.003~0.008，规则 1/2b 的橘门槛永远够不着，反而被
    #     规则 5（白+暖）吞成「橘猫」—— 实测三张「三花-身体白头三花」全中。
    #     改用组合证据：浅色身体（light 含阴影里的白毛）+ 暗橘/棕橘块（暖光下
    #     橘毛常落进 brown 桶）+ 小面积真黑 + 暖白（cream）不能多。
    #     cream 上界挡「暖光下的纯白猫」：那股 brown 是整身均匀色偏，不是斑块；
    #     warm 上界 0.25 挡「乳橘猫 + 白墙 + 阴影」（实测 warm 0.296、brown 0.279，
    #     身体本身就是暖色，白与暗都来自环境）；真白身三花 warm 只有 0.207~0.211。
    #     warmish 上界 0.30 挡「棚拍白背景的狸花」（同形状的白+黑+棕，但暖色
    #     证据来自整身底毛 0.42；真白身三花只有 0.23~0.28）。
    if (light >= 0.30 and brown >= 0.15 and warm < 0.25 and cream < 0.12 and
            (warmish is None or warmish < 0.30) and
            black >= 0.02 and dark >= 0.05):
        return "calico", "calico"
    # 3) 黑白两色调（2026-10-24 重写）：有效浅色与有效暗色都够量、且暖色少
    #    → 奶牛 / 燕尾服。分界从「白 vs 黑谁多」改成 light≥0.22：
    #    民间「奶牛猫」指黑白斑块猫，黑多白少也是奶牛；只有白块很小的
    #    （白围脖白爪）才是燕尾服。实测 4 张奶牛照 light 0.26~0.39 全部落对。
    #    🔴 条纹**不再是**绝对排除项（2026-10-31）：奶牛猫的黑白大斑块边界会产生
    #    周期性梯度（抠图后实测奶牛猫1 stripe 0.64 ≥ 门槛），旧条件
    #    `not has_tabby` 直接把它挡在这条规则外，落到规则 8 判成白猫。
    #    但有两条限制：① 必须**拿得到 warmish 证据**（抠图后才有；没证据时
    #    保守退回旧行为，aggregate 里那些没带 warmish 的帧不会因此翻成奶牛）；
    #    ② 暖色证据必须低（真狸花底毛 0.37，奶牛 0.01~0.09）。
    #    🔴 **gray 必须少**（2026-10-26 新增，实测白猫/夜间白猫各误判一次）：
    #    奶牛猫的物理本质是「两块不同色相的毛」，V 分布是**双峰**；
    #    而一只灰白猫（或任何单色猫）在光线下的明暗变化，会让同一团毛同时
    #    贡献 light（亮部）和 dark（暗部）—— 两色调规则原封不动命中。
    #    实测标准白猫素材 gray=0.45、用户夜间白猫 gray=0.51，都因此判成奶牛；
    #    真奶牛照 gray 都在 0.2 上下。所以把「gray 少」列为必要条件：
    #    颜色要真的分成黑白两块，不能是一团灰的渐变。
    #    🔴 **warmish 必须少**（2026-10-28 新增，实测狸花猫棚拍照误判奶牛）：
    #    「狸花猫 + 白背景棚拍」= 白（背景）+ 黑（条纹）双量齐高，规则原样命中；
    #    但狸花底毛是暖黄褐（warmish 实测 0.37），而真奶牛猫黑白毛都不含暖色
    #    （4 张实测 0.01~0.09）。ratio 里的 warm 桶有 V 门槛、夜间会塌，
    #    warmish 是 V 免疫证据 —— 用它做这道闸，夜里也拦得住。
    #    ⚠️ 已知边界：玄猫（纯黑）+ 白背景在色域空间里与奶牛无法区分
    #    （warmish 同样 ≈0），仍会判奶牛 —— 直方图信息上限，不做硬猜。
    #    见「条纹不再是绝对排除项」注释：有条纹时必须带 warmish 证据才放行。
    #    暖色总量上界 0.25 → 0.30（2026-10-31）：奶牛猫.jpg 实测 warm=0.252，
    #    原上界把它挡在门外；同一张图的 warmish=0.313 已在下面的 V 免疫闸放宽
    #    到 0.34。真狸花 warm 0.30~0.55（且有 warmish 0.37+），仍被两道闸拦住。
    #    🔴 **brown 必须少**（2026-10-31 新增）：暖色闸放宽到 0.30/0.34 之后，
    #    米黄/棕色纯色猫（乳橘猫趴在白墙旁，实测 brown 0.279、warm 0.296、
    #    light 0.37 / dark 0.31）会整条命中奶牛规则。真奶牛猫的暖色只来自
    #    暖光下的白毛（cream 少量，brown 实测 0.003~0.076），棕毛本身不存在。
    cow_striped = (has_tabby and warmish is not None and
                   warmish < config.ATTR_COW_MAX_WARM)
    if ((not has_tabby or cow_striped) and warm < 0.30 and
            brown < config.ATTR_COW_MAX_BROWN and
            gray < config.ATTR_COW_MAX_GRAY and
            (warmish is None or warmish < config.ATTR_COW_MAX_WARM) and
            ((light >= 0.15 and dark >= 0.16) or
             (white >= 0.45 and dark >= 0.08))):    # 白底 + 小块黑斑（大多白奶牛）
        return ("cow" if (light >= 0.22 or light >= dark) else "tuxedo"), "cow"
    # 4) 三花（宽松，兜底随机 mosaic 那种白块偏少的构造）。
    #    🔴 **必须有鲜明橘**（2026-10-26 新增，实测橘猫标准素材误判三花）：
    #    宽松规则原本只看 white+dark+warm，而「浅橘/乳橘猫 + 白墙 + 阴影」
    #    的统计和三花一模一样 —— 白来自墙、暗来自阴影、暖来自落进 brown 桶
    #    的低饱和橘毛（实测 white=0.285/dark=0.31/warm=0.28、orange 桶只有
    #    0.003）。真三花必有可观鲜明橘块（严格规则门槛 0.08），宽松规则
    #    降到 0.05 兜底；低于它的 white+dark+warm 改走规则 5 判橘系 ——
    #    「橘白猫」远比「墙根下的橘猫被判三花」接近真相。
    if (white >= 0.16 and dark >= 0.12 and warm >= 0.14 and
            orange >= config.ATTR_CALICO_MIN_ORANGE):
        return "calico", "calico"
    # 5) 白 + 暖色（橘白 / 白橘）
    #    🔴 **black 桶必须少**（2026-10-29 新增，实测玳瑁/狸花棚拍误判橘白）：
    #    白背景下玳瑁/狸花的 black 桶被真实黑毛撑高（0.19~0.38），
    #    white（背景）+ warm（棕/橘底毛）双量齐高，规则原样命中判成橘白。
    #    用 black 桶而非 dark：乳橘猫的 dgray（阴影）可达 0.23 但 black 只
    #    有 0.08，用 dark 会误伤真橘白。
    if (white >= 0.22 and warm >= 0.18 and
            black < config.ATTR_ORANGE_WHITE_MAX_BLACK):
        return "orange", tabby_like
    # 6) 暖色主导：鲜明橘够多才是橘猫，否则按条纹判狸花。
    #    橘色占比门槛（0.15）不能省：狸花猫的底毛是浅黄褐（落 cream 桶）+ 黑条纹，
    #    暖色总量很高但几乎没有"鲜明橘"，靠总量判会把狸花全判成橘猫。
    if warm >= 0.30 and warm >= gray:
        if orange >= 0.15:
            return "orange", tabby_like
        return ("tabby", "tabby") if (has_tabby or weak_tabby) else ("orange", "solid")
    # 7) 有真条纹且暗色够量 → 狸花。必须在单色规则**之前**：狸花猫的黑条纹 +
    #    阴影经常把 gray 桶堆到 0.40+（实测两张狸花 gray 0.30~0.45），
    #    先判单色会把它们全吃成「灰猫」。
    #    🔴 **必须有暖色底毛**（2026-10-26 新增，实测黑猫标准素材误判狸花）：
    #    狸花的物理本质是「暖色底毛 + 深色条纹」，底毛再暗，色相与饱和度也
    #    在（S/H 对亮度天然免疫，这正是 warmish 不设 V 门槛的原因）。而黑猫
    #    趴在沙发/地毯上时，织物褶皱是强方向性周期纹理，stripe 分一样虚高
    #    （实测 0.63 过线），但暖色系像素只有 6.8% —— 低于门槛的高条纹分
    #    只能来自环境纹理，不能给黑猫凭空长出条纹。
    #    🔶 **弱条纹带**：定义在所有规则之前（见上），这里直接复用。
    #    🔴 **亮灰底色的狸花**（2026-10-31 新增，实测「狸花猫2」判成白猫）：
    #    银虎斑/灰褐狸花的底毛不是暖黄褐，warmish 只有 0.059，被暖色闸挡住；
    #    但它的「有效浅色」light = white + 亮灰 = 0.258（暗灰 0.275 已扣除），
    #    说明有一半以上是**中等亮度的毛** —— 纯白猫的中等亮度像素会被 white
    #    桶吃掉（light 更高但 dark 低），纯黑/玄猫 light 实测 0.037~0.041。
    #    所以「light ≥ 0.15」是灰底狸花的第二条证据，和暖色底毛并列。
    if ((has_tabby or weak_tabby) and dark >= 0.12 and
            (warmish is None or warmish >= config.ATTR_TABBY_MIN_WARM or
             light >= 0.15)):
        return "tabby", "tabby"
    # 8b) 夜间白猫救援（2026-10-31）：抠图只留猫毛后，夜里欠曝的白毛整桶
    #     掉进 gray/black（white 桶只剩 0.10、gray 0.57），但「亮毛像素」
    #     （V≥ATTR_BRIGHT_V 且 S≤ATTR_BRIGHT_S）占比仍有 0.11 —— 而玄猫
    #     只有 0.001~0.002、玳瑁 0.027~0.031、狸花 0.056~0.074，差一个量级。
    #     夜里白猫饱和度很低（27~30），玄猫的 JPG 彩色噪点反而偏高（68~90），
    #     所以 sat 上限是第二道闸。必须放在单色规则之前：否则 dark 0.5+ 先
    #     判成黑猫。第三道闸是 black 桶上限（2026-10-31）：奶牛猫的白胸白脸
    #     同样满足 bright/sat（实测奶牛猫1 bright 0.17、sat 38.6），但黑毛
    #     占比高（black 0.70），而夜间白猫几乎全白（0.24~0.25）。
    if (bright is not None and sat is not None and
            bright >= config.ATTR_WHITE_NIGHT_BRIGHT and
            sat <= config.ATTR_WHITE_NIGHT_SAT and
            black < config.ATTR_WHITE_NIGHT_MAX_BLACK):
        return "white", "solid"
    # 8) 单色：白 / 黑 / 灰
    if white >= 0.50:
        return "white", "solid"
    if dark >= 0.50:
        return "black", "solid"
    if gray >= 0.40:
        return "gray", tabby_like
    # 9) 都不占绝对多数 → 取最大桶，别硬凑
    top = max(_CAT_BUCKETS, key=lambda k: ratio[k])
    if ratio[top] < 0.16:
        return "", ""
    mapping = {"white": "white", "black": "black", "gray": "gray",
               "orange": "orange", "cream": "orange", "brown": "tabby",
               "red": "tortoiseshell"}
    return mapping.get(top, ""), tabby_like


def _remote(im: Image.Image) -> Optional[dict]:
    """可选：把图片 POST 给自建/公开的属性识别接口。

    协议（本服务约定，接任何后端都按这个格式适配一次即可）：
        POST {ATTR_API_URL}
        Authorization: Bearer {ATTR_API_TOKEN}   # 有配置才带
        {"image": "<base64 jpeg>", "want": ["color", "pattern", "breed"]}
        →  {"color": "orange", "pattern": "tabby", "breed": "橘猫", "confidence": 0.82}

    为什么要传 base64 而不是图片 URL：识别服务多为内网/云托管实例，
    对方的接口未必能回连下载我们这边的临时链接，传字节是唯一稳定做法。

    任何异常（未配置 / 超时 / 非 200 / 字段缺失）一律返回 None 让调用方
    降级到本地启发式 —— **远程识别是加分项，不能成为单点故障**。
    """
    url = getattr(config, "ATTR_API_URL", "")
    if not url:
        return None
    try:
        import httpx  # 已在 requirements（素材下载也用它）
    except ImportError:
        log.warning("ATTR_API_URL 已配置但缺少 httpx，跳过远程属性识别")
        return None

    buf = io.BytesIO()
    im.convert("RGB").resize((256, 256), Image.BILINEAR).save(buf, format="JPEG", quality=88)
    payload = {"image": base64.b64encode(buf.getvalue()).decode("ascii"),
               "want": ["color", "pattern", "breed"]}
    headers = {}
    if getattr(config, "ATTR_API_TOKEN", ""):
        headers["Authorization"] = "Bearer " + config.ATTR_API_TOKEN

    try:
        r = httpx.post(url, json=payload, headers=headers,
                       timeout=float(getattr(config, "ATTR_API_TIMEOUT", 4) or 4))
        if r.status_code != 200:
            log.warning("远程属性识别返回 %s：%s", r.status_code, r.text[:200])
            return None
        d = r.json()
    except Exception as e:  # noqa: BLE001 —— 见 docstring：远程挂了不能拖垮识别
        log.warning("远程属性识别失败：%s: %s", type(e).__name__, e)
        return None

    color = str(d.get("color") or "").strip()
    if color not in COLOR_LABELS:
        log.warning("远程属性识别返回了未知 color=%r，已忽略", color)
        return None
    pattern = str(d.get("pattern") or "").strip()
    breed = str(d.get("breed") or "").strip() or _breed_of(color, pattern)
    return {
        "color": color,
        "pattern": pattern,
        "breed": breed,
        "confidence": max(0.0, min(1.0, float(d.get("confidence") or 0.8))),
        "source": "api",
        "palette": [],
        "stripe": 0.0,
        "reason": "",
    }


def _resize_mask(mask, size: int) -> Optional[np.ndarray]:
    """把任意尺寸/0~255 或 0~1 的掩膜缩到 size×size 的 0~1 浮点图。

    掩膜来自 matting.foreground（原图尺寸、0~1）。这里统一转成「权重」：
    软边保留（毛边不会硬切），但背景严格为 0 —— 色域统计只数猫毛。
    """
    if mask is None:
        return None
    try:
        m = np.asarray(mask, dtype=np.float32)
        if m.ndim > 2:
            m = m[..., 0]
        if m.ndim != 2 or m.size == 0:
            return None
        if float(m.max()) > 1.0 + 1e-3:          # 0~255 的掩膜（外部调用可能这么传）
            m = m / 255.0
        m = np.clip(m, 0.0, 1.0)
        if m.shape[:2] != (size, size):
            m = np.asarray(
                Image.fromarray((m * 255).astype(np.uint8)).resize((size, size), Image.BILINEAR),
                dtype=np.float32) / 255.0
        return m
    except Exception:        # noqa: BLE001 —— 掩膜坏了就当没有，退回整框统计
        return None


def _robust_reweight(weight: np.ndarray, fg: np.ndarray,
                     idx: np.ndarray) -> Tuple[np.ndarray, int]:
    """L1 稳健统计：剔除与整体色板**显著不一致**的前景瓦片，返回 (新权重, 剔除数)。

    动机（2026-11-05）：全局直方图不抗污染 —— 一只伸进画面的手、一块红袖，
    只要被抠进掩膜，就按面积改写全局比例（实测「奶牛猫4」人手把 warmish
    从 0.22 抬到 0.38）。但污染有个可利用的结构特征：**它是局部的**。
    猫的花色沿身体分布，手只占一两个角落。

    做法：把 96×96 分析网格切成 3×3 瓦片，每块算自己的色桶分布；
    取所有瓦片的**分量中位数**当「身体基准」，把 L1 距离显著偏离基准的瓦片
    权重清零，再汇总剩下的像素。猫身上正常的白块/黑块不会被误剔：
    它们沿身体成片分布，瓦片间彼此相似，距离中位数近；而污染瓦片孤立、
    偏离所有瓦片的中位数。

    剔除条件 `d > max(ATTR_ROBUST_DIST, ATTR_ROBUST_MAD × median(d))`：
    绝对下限挡住「所有瓦片本来就像」时的噪声抖动，MAD 倍率让「猫有两种
    主色、瓦片天然分两群」时谁也不被剔（两群距离都大，median(d) 也大）。

    只在掩膜模式下启用：整图模式里背景本来就占瓦片的大多数，「剔除离群瓦片」
    会把唯一有猫的角落剔掉。条纹分不受影响（纹理必须在完整前景上算）。
    """
    size = weight.shape[0]
    n = max(2, int(_cfg("ATTR_ROBUST_TILE", 3)))
    step = size // n
    vecs, tiles = [], []
    for ty in range(0, size - step + 1, step):
        for tx in range(0, size - step + 1, step):
            tw = weight[ty:ty + step, tx:tx + step]
            tfg = fg[ty:ty + step, tx:tx + step]
            # 瓦片里几乎没有猫体 → 统计不可靠，跳过（不参与基准也不参与剔除）
            if float(tw.sum()) <= 0 or float(tfg.mean()) < _cfg("ATTR_ROBUST_MIN_TILE", 0.3):
                continue
            cnt = np.bincount(idx[ty:ty + step, tx:tx + step].ravel(),
                              weights=tw.ravel(), minlength=len(_BUCKETS))
            vecs.append(cnt / float(tw.sum()))
            tiles.append((ty, tx))
    if len(vecs) < 4:        # 瓦片太少，中位数/距离都不稳定，放弃稳健化
        return weight, 0
    mat = np.stack(vecs)
    med = np.median(mat, axis=0)
    dist = np.abs(mat - med).sum(axis=1)
    medd = float(np.median(dist))
    floor = _cfg("ATTR_ROBUST_DIST", 0.25)
    k = _cfg("ATTR_ROBUST_MAD", 3.0)
    drop = [i for i, d in enumerate(dist) if d > max(floor, k * medd)]
    if not drop:
        return weight, 0
    out = weight.copy()
    for i in drop:
        ty, tx = tiles[i]
        out[ty:ty + step, tx:tx + step] = 0.0
    # 极端保险：剔完剩下的有效权重不能太少（防整只猫被剔没）
    if float(out.sum()) < 0.3 * float(weight.sum()):
        return weight, 0
    return out, len(drop)


def _mask_extent(mask) -> Optional[float]:
    """掩膜前景在**水平方向**覆盖了多少（2%~98% 分位跨度 ÷ 画面宽度）。

    用来判断「抠图有没有丢掉猫体的一部分」，不是判断猫有多大：
    分母是整幅图宽度，所以「猫只占画面一角」不会让它变小，只有
    「猫体左/右半边被抠掉」才会。用分位数而不是 min/max，避免个别
    孤立噪点把跨度撑满。

    实测（35 张真实素材）：正常抠图 0.60~0.90；「奶牛猫-有人手干扰-裁剪」
    过曝白毛被整块丢掉，只有 0.51。但 0.36 的两张（奶牛猫3、橘猫-遮挡0）
    结论是对的 —— **单独用它拒识会误伤**，所以它只作为「口径互斥」的
    定位手段（见 _consistency_gate）。
    """
    if mask is None:
        return None
    m = _mask_array(mask)
    if m is None:
        return None
    fg = m >= _cfg("MATTING_ALPHA_THR", 0.5)
    h, w = fg.shape[:2]
    col = fg.sum(axis=0)
    # 列内前景像素够多才算「这一列有猫」，避免边缘几个噪点把跨度撑满；
    # 不用分位数：分位数会把两端各削掉一截，满幅掩膜算出来只有 0.95 左右。
    xs = np.where(col >= max(1, int(0.02 * h)))[0]
    if xs.size < 2:
        return 0.0
    return float(xs[-1] - xs[0] + 1) / float(w)


def _consistency_gate(mask_color: str, frame_color: str,
                      extent: Optional[float]) -> str:
    """两套统计口径互斥、且掩膜不完整时，返回拒识原因；否则返回空串。

    花色判定本质是「掩膜内像素的全局比例」，它同时依赖两件事：抠图选对了
    像素、检测框框住了猫。遮挡会同时破坏这两点 —— 手被抠进掩膜 → 暖色比例
    暴涨；过曝的白毛被抠掉 → 白色比例暴跌。叠加后「黑白猫」会滑进「橘猫」
    分支（实测就是「奶牛猫-有人手干扰-裁剪.jpg」，同一张图不裁剪时判 cow）。

    应对不是再调一条阈值，而是**让两套口径互查**：
      - 套掩膜的统计（抗背景、但怕抠图丢块）；
      - 不套掩膜的整幅统计（不怕丢块、但会被背景污染）。
    两者本身都不是权威，但 `hard_exclusive()` 描述的是「物理上不可能同时
    成立」—— 一旦互斥，至少一套已经失效。

    再用 extent 定位是哪一套失效：掩膜横向不完整 → 问题在抠图 → **弃权**；
    掩膜完整 → 问题在整幅统计被背景污染（实拍里很常见，如白猫黑天里
    整幅统计判 black）→ 保留掩膜结论，不打扰用户。

    实测（35 张真实素材）：同时满足「互斥 + extent<0.7」的只有用户反馈的
    那一张；其余 34 张结论不变。
    """
    if not mask_color or not frame_color:
        return ""
    if extent is None:
        return ""
    if extent >= _cfg("ATTR_MASK_EXTENT_MIN", 0.70):
        return ""
    if not hard_exclusive(mask_color, frame_color):
        return ""
    return ("画面里猫体被遮挡或没有完整入镜（抠图只覆盖横向 %d%%），"
            "两种统计口径得出的花色互相矛盾（%s / %s），这次不下结论。"
            "请把猫完整拍进画面、避免人手或他物遮挡后重试"
            % (int(round(100 * extent)),
               PATTERN_LABELS.get(mask_color, mask_color),
               PATTERN_LABELS.get(frame_color, frame_color)))


def _stats_of(rgb: Image.Image, cropped: bool,
              mask: Optional[np.ndarray] = None) -> Optional[dict]:
    """算出**中间统计量**，不做最终判定。返回 None = 有效像素不足。

    单独抽出来是为了多帧聚合（见 `merge_stats`）：视频里每一帧都能算出这个
    dict，把多帧的 ratio 加权平均、stripe 取中位数，再统一走一次 _decide，
    比「每帧各判一次然后挑置信度最高的」稳得多 —— 后者等于让某一帧单独
    做决定，糊帧/逆光帧照样能一票定生死。

    mask（可选，来自 matting.foreground）：
      - 给了就**只统计前景像素**（软掩膜当权重），背景墙/地板/床单不再污染色桶；
      - 条纹也在前景上算：背景像素替换成前景灰度中位数，避免掩膜边界被
        当成「边缘」抬高清真度；
      - 额外输出 bright（亮毛占比）/ sat（平均饱和度），供夜间白猫救援使用
        （见 _decide 规则 8b）。没给掩膜时这两项是 None —— 绝不拿含背景的
        统计冒充「猫毛的亮度」，那会把白天白墙误当夜里白猫。
    """
    small = rgb.resize((_SIZE, _SIZE), Image.BILINEAR)
    hsv = np.asarray(small.convert("HSV"))
    hd = hsv[..., 0].astype(np.float32) * (360.0 / 255.0)
    s = hsv[..., 1].astype(np.float32)
    v = hsv[..., 2].astype(np.float32)

    # 整图模式给边缘降权；裁剪模式（检测框已紧贴猫体）全权重，不削耳朵和尾巴
    weight = (np.ones((_SIZE, _SIZE), dtype=np.float64) if cropped
              else _center_weight(_SIZE, _SIZE))

    mask_small = _resize_mask(mask, _SIZE)
    fg = None
    if mask_small is not None:
        thr = _cfg("MATTING_ALPHA_THR", 0.5)
        fg = mask_small >= thr
        if not bool(fg.any()):
            mask_small = None
        else:
            weight = mask_small.astype(np.float64)

    shift = _exposure_shift(v, weight, s)
    idx = _classify(hd, s, v, shift)

    # L1 稳健统计（2026-11-05）：掩膜模式下剔除与整体色板显著不一致的
    # 前景瓦片（手/衣袖等局部遮挡），再汇总色桶。整图模式不做（见
    # _robust_reweight 的 docstring）。剔除数写进 stats 供诊断。
    dropped = 0
    if fg is not None and _cfg("ATTR_ROBUST_STATS", False):
        weight, dropped = _robust_reweight(weight, fg, idx)
        if float(weight.sum()) <= 0:
            return None

    counts = np.bincount(idx.ravel(), weights=weight.ravel(),
                         minlength=len(_BUCKETS))
    total = float(counts.sum())
    valid = total - float(counts[_OTHER])
    if total <= 0 or valid < total * config.ATTR_MIN_COVERAGE:
        return None

    ratio = {b: float(counts[i]) / total for i, b in enumerate(_BUCKETS)}
    # 「暗灰」占比：低饱和像素里落在暗部区间的那部分。黑毛反光会落到这个区间
    # （实测奶牛猫照 gray 桶 51% 里 28% 是暗灰），_decide 用它做有效暗色。
    # 窗口跟着 shift 一起平移，否则曝光一变它就和 black 桶接不上。
    dgray = float(weight[(s <= 45) & (v > 62.0 + shift) & (v <= 125.0 + shift)].sum()) / total

    # 「暖色系像素」占比：H 5~55、S≥50，**不限亮度**。狸花判定的必要证据
    # （见 _decide 规则 7）：底毛的色相/饱和度对曝光免疫，夜间 V 全塌时它是
    # 唯一还能区分「真狸花」和「黑猫 + 织物纹理」的量。
    warmish = float(weight[(hd >= 5) & (hd <= 55) & (s >= 50)].sum()) / total

    # 「暖白」占比（2026-10-31 新增）：亮度已到白毛区间（V≥175，与 white 同口径），
    # 但饱和度比纯白高一点（S 55~80）、色相偏暖（H 20~70）。
    # 这是**暖光/室内灯下的白毛**：S 被光源染到 56~79，`_classify` 的 white
    # 只收到 S≤55，于是这部分白毛全部掉进 cream（奶黄）桶。
    # 实测「三花猫」实拍（白肚皮 + 暖光）：white 0.18 / cream 0.21 / 暖白 0.05，
    # 严格三花规则要 white≥0.28 永远够不着，最终被判成「橘狸花」。
    # 单列一项而不是直接改 white 的 S 上限：把 S 放宽到 80 会让**白背景**
    # （棚拍高调背景 S≈0~20 不受影响，但浅色墙/床单会）混进 white，
    # 实测玳瑁棚拍照 white 从 0.03 涨到 0.35 直接改判橘猫。只给三花判定用最安全。
    pale = float(weight[(hd >= 20) & (hd <= 70) & (s > 55) & (s <= 80)
                        & (v >= 175.0 + 0.5 * shift)].sum()) / total

    # 亮毛占比 / 平均饱和度（仅掩膜模式；见 docstring）
    bright = None
    sat = None
    vmed = None
    if mask_small is not None:
        bv = _cfg("ATTR_BRIGHT_V", 170.0)
        bs = _cfg("ATTR_BRIGHT_S", 60.0)
        bright = float(weight[(v >= bv) & (s <= bs)].sum()) / total
        sat = float((s * weight).sum()) / total
        vmed = _wquantile(v, weight, 0.5)

    # 条纹检测：非裁剪图先内缩 10% 再算梯度，避开照片边框/水印造成的假边缘。
    # （2026-10-28 曾试过暗图先直方图均衡再测条纹：条纹分 85% 由尺度不变的
    #  带数/调制比/方向性构成，均衡前后逐分不差，纯噪声场景也无效 —— 已撤掉，
    #  暗光的真问题在曝光锚点被点光源劫持，见 _exposure_shift 的眩光防护。）
    g = np.asarray(small.convert("L"), dtype=np.float32)
    if fg is not None:
        # 背景替换成前景中位灰度：掩膜外侧的墙/地板纹理不再贡献假边缘，
        # 同时避免「前景→0」的硬边界被条纹检测当成一条超强的明暗带。
        g = np.where(fg, g, float(np.median(g[fg])))
    if not cropped:
        pad = int(_SIZE * 0.10)
        g = g[pad:_SIZE - pad, pad:_SIZE - pad]
    stripe = _stripe_score(g)

    return {"ratio": ratio, "dgray": dgray, "warmish": warmish, "pale": pale,
            "stripe": stripe, "coverage": valid / total, "shift": shift,
            "bright": bright, "sat": sat, "vmed": vmed, "robustDropped": dropped}


def merge_stats(stats: List[dict]) -> Optional[dict]:
    """把多帧的中间统计量合成一份，供**统一判定**一次。

    聚合口径（三条都是刻意选的）：
      ratio   → 按有效覆盖率**加权平均**。糊帧/逆光帧的可用像素少，权重自然低，
                不会把整只猫的色板拽偏。
      stripe  → 取**中位数**。条纹分是 0~1 的标量，个别帧的假边缘（背景栏杆、
                草地纹理）会给出离谱的高分，平均值会被它拖走，中位数不会。
      shift   → 同样取中位数（曝光在一段视频里基本恒定，取中位数抗单帧过曝）。
      dgray   → 加权平均，与 ratio 同源。
    """
    ok = [x for x in (stats or []) if x and x.get("ratio")]
    if not ok:
        return None
    if len(ok) == 1:
        return ok[0]

    w = [max(1e-6, float(x.get("coverage") or 0.0)) for x in ok]
    tw = float(sum(w))
    ratio = {b: sum(float(x["ratio"].get(b, 0.0)) * wi for x, wi in zip(ok, w)) / tw
             for b in _BUCKETS}
    dgray = sum(float(x.get("dgray") or 0.0) * wi for x, wi in zip(ok, w)) / tw
    # warmish 与 dgray 同源加权平均，但**只对提供了该量的帧平均**：一帧都没
    # 提供就输出 None（=「没有这项证据」，_decide 的门槛不生效）。绝不能把
    # 「没算过」折算成 0 —— 那会把所有旧结构/外部构造的帧一夜之间判不出狸花
    # （2026-10-26 test_disagreement_written_to_reason 实测踩中）。
    wv = [(float(x["warmish"]), wi) for x, wi in zip(ok, w)
          if x.get("warmish") is not None]
    warmish = (sum(v * wi for v, wi in wv) / sum(wi for _, wi in wv)) if wv else None
    # bright / sat 同理：只有掩膜帧才提供。没提供的帧不参与平均；一帧都没有
    # → None（夜间白猫救援不生效，保持旧判定）。
    wb = [(float(x["bright"]), wi) for x, wi in zip(ok, w)
          if x.get("bright") is not None]
    bright = (sum(v * wi for v, wi in wb) / sum(wi for _, wi in wb)) if wb else None
    ws = [(float(x["sat"]), wi) for x, wi in zip(ok, w)
          if x.get("sat") is not None]
    sat = (sum(v * wi for v, wi in ws) / sum(wi for _, wi in ws)) if ws else None
    stripe = float(np.median([float(x.get("stripe") or 0.0) for x in ok]))
    shift = float(np.median([float(x.get("shift") or 0.0) for x in ok]))
    coverage = tw / len(ok)
    # pale（暖白）默认 0：它只是三花判定的补量，缺这项时等价于「没有暖白」，
    # 与旧版 white 门限行为一致，不会因聚合帧缺失而放宽三花判定。
    pale = sum(float(x.get("pale") or 0.0) * wi for x, wi in zip(ok, w)) / tw
    return {"ratio": ratio, "dgray": dgray, "warmish": warmish, "pale": pale,
            "stripe": stripe, "coverage": coverage, "shift": shift, "frames": len(ok),
            "bright": bright, "sat": sat}


def _confidence_of(ratio: dict, agreement: float = 1.0) -> float:
    """置信度 = 色集中度 × 多帧一致性。

    为什么加一致性这一项（2026-10-25）：原来只看「最大色占比」，于是单帧
    判定哪怕在几帧之间反复横跳（同一只猫 3 帧判橘、2 帧判狸花），也照样
    给 0.7+ 的高置信 —— 而「没匹配到猫」时用户看到的正是这个数，它会让人
    以为「猫没认出来，但花色是确定的」。把一致性乘进去，横跳的结论自然
    落到 0.5 以下，前端就能据此标「仅供参考」。

    agreement=1（单帧或全票）时完全不打折，保证单图识别的行为不变。
    """
    top1 = max(ratio[k] for k in _CAT_BUCKETS)
    base = min(0.88, 0.45 + 0.40 * min(1.0, top1 / 0.55))
    return round(float(base * (0.62 + 0.38 * max(0.0, min(1.0, agreement)))), 3)


def analyze(im: Image.Image, cropped: bool = False,
            mask: Optional[np.ndarray] = None) -> dict:
    """本地启发式属性分析。

    cropped=True 表示传进来的是检测框裁出的猫体，已经紧贴主体 ——
    此时不再套中央椭圆（否则会削掉耳朵/尾巴），也不内缩边框。
    mask 是可选的前景掩膜（matting.foreground 的输出，与 im 同尺寸）：
    给了就只统计猫毛像素（见 _stats_of）。
    """
    try:
        rgb = im.convert("RGB")
    except Exception as e:  # noqa: BLE001
        return _empty("图片无法解析：%s" % e)

    if rgb.size[0] < 8 or rgb.size[1] < 8:
        return _empty("图片太小（%dx%d）" % rgb.size)

    # 先问「这张照片能不能判断花色」，再问「是什么花色」。
    # 顺序很重要：糊片/猫体几乎不存在时，后面的色域统计只是在给噪声做解释。
    q = _quality_gate(rgb, mask)
    if not q["ok"]:
        return _empty(q["reason"], refused=True, quality=q)

    st = _stats_of(rgb, cropped, mask=mask)
    if st is None:
        # 覆盖率不足时 _stats_of 没返回 ratio，这里重算一次只为给出可读的原因
        small = rgb.resize((_SIZE, _SIZE), Image.BILINEAR)
        hsv = np.asarray(small.convert("HSV"))
        hd = hsv[..., 0].astype(np.float32) * (360.0 / 255.0)
        s = hsv[..., 1].astype(np.float32)
        v = hsv[..., 2].astype(np.float32)
        weight = (np.ones((_SIZE, _SIZE), dtype=np.float64) if cropped
                  else _center_weight(_SIZE, _SIZE))
        mask_small = _resize_mask(mask, _SIZE)
        if mask_small is not None:
            weight = mask_small.astype(np.float64)
        idx = _classify(hd, s, v)
        counts = np.bincount(idx.ravel(), weights=weight.ravel(),
                             minlength=len(_BUCKETS))
        total = float(counts.sum()) or 1.0
        valid = total - float(counts[_OTHER])
        return _empty("画面里猫体区域不足（有效占比 %d%%，需 %d%%）"
                      % (int(round(100.0 * valid / total)),
                         int(round(100 * config.ATTR_MIN_COVERAGE))))

    ratio, dgray, stripe = st["ratio"], st["dgray"], st["stripe"]
    color, pattern = _decide(ratio, stripe, dgray, st.get("warmish"),
                             bright=st.get("bright"), sat=st.get("sat"),
                             pale=st.get("pale"))
    if not color:
        return _empty("颜色不集中（最大色占比 %d%%），无法判断花色"
                      % int(round(100 * max(ratio[k] for k in _CAT_BUCKETS))))

    # 口径一致性检查：掩膜口径 vs 整幅口径互斥且抠图不完整 → 弃权（见
    # _consistency_gate 的 docstring）。只在真有掩膜时才算，不增加无掩膜部署的开销。
    if mask is not None and bool(getattr(config, "ATTR_CONSISTENCY_GATE", True)):
        st_frame = _stats_of(rgb, cropped, mask=None)
        if st_frame is not None:
            frame_color, _fp = _decide(st_frame["ratio"], st_frame["stripe"],
                                       st_frame["dgray"], st_frame.get("warmish"),
                                       bright=st_frame.get("bright"),
                                       sat=st_frame.get("sat"),
                                       pale=st_frame.get("pale"))
            extent = _mask_extent(mask)
            why = _consistency_gate(color, frame_color, extent)
            if why:
                return _empty(why, refused=True, consistency={
                    "mask": color, "frame": frame_color,
                    "extent": None if extent is None else round(extent, 3)})

    palette = [
        {"key": b, "label": _BUCKET_LABELS.get(b, b), "ratio": round(ratio[b], 3)}
        for b in sorted(_CAT_BUCKETS, key=lambda k: -ratio[k])[:3]
        if ratio[b] >= 0.05
    ]

    return {
        "color": color,
        "pattern": pattern,
        "breed": _breed_of(color, pattern),
        "confidence": _confidence_of(ratio),
        "source": "heuristic",
        "palette": palette,
        "stripe": stripe,
        # 曝光平移量：排查「同一只猫换个光就判成另一种花色」时，先看它是否剧烈变化
        "shift": round(float(st["shift"]), 1),
        "reason": "",
        # 内部字段（下划线前缀）：多帧聚合要复用中间量，对外接口不输出它
        "_stats": st,
    }


def merge_and_decide(results: List[dict]) -> Optional[dict]:
    """多帧启发式结论**聚合判定**——「没匹配到猫时展示的花色」准确度的主修复。

    旧行为：每帧各判一次，取「置信度最高的那一帧」。问题在于置信度只反映
    「这一帧颜色有多集中」，不反映「结论有多可靠」—— 一张糊帧/逆光帧完全
    可能给出 0.75 的高置信错误结论，而多数帧的正确结论被无视。

    新行为（两级）：
      1. **色板级聚合**：把各帧的中间统计量（ratio/dgray/stripe，见 _stats_of）
         按覆盖率加权平均，再统一走一次 _decide。色板是连续量，平均后糊帧
         的干扰被稀释；比「离散标签投票」信息量更大（三花这类多色猫在
         单帧里色板本来就在门槛边缘抖动，平均后才稳定过线）。
      2. **标签级投票**：各帧独立判出的 color 做多数票，一致率（agreement）
         折进置信度 —— 3 帧判橘 2 帧判狸花时，置信度自动降到 0.5 以下，
         前端据此标「仅供参考」，而不是把横跳的结论当确定事实展示。

    results 是每帧 analyze()/CLIP 的输出。只聚合 heuristic 帧（CLIP 没有中间
    统计量）；**没有任何启发式帧时返回 None**，调用方退回旧逻辑（最佳单帧）。
    """
    heur = [r for r in (results or [])
            if r.get("source") == "heuristic" and not r.get("reason") and r.get("_stats")]
    if not heur:
        # 所有帧都被质量门拦下：把拒识原因带出去（重拍提示）。返回 None 会让
        # 上层退化成「没有可用于判断花色的区域」这类泛化文案，用户不知道该
        # 怎么改；这里的 reason 直接指出是糊了还是猫没入镜。
        refused = [r for r in (results or []) if r.get("refused")]
        return dict(refused[0]) if refused else None

    st = merge_stats([r["_stats"] for r in heur])
    if st is None:                                  # 理论到不了（heur 都有 ratio）
        return None

    ratio, dgray, stripe = st["ratio"], st["dgray"], st["stripe"]
    color, pattern = _decide(ratio, stripe, dgray, st.get("warmish"),
                             bright=st.get("bright"), sat=st.get("sat"),
                             pale=st.get("pale"))

    votes = [r["color"] for r in heur if r.get("color")]
    reason = ""
    if not color:
        # 聚合后仍判不出：别硬凑。若某单帧判出来了，带上它当「仅供参考」——
        # 多帧平均把边缘结论抹平是常态，但单帧的弱结论也比空着有信息量。
        cand = [r for r in heur if r.get("color")]
        if not cand:
            return _empty("各帧均未能判定花色（颜色不集中）")
        best = max(cand, key=lambda r: float(r.get("confidence") or 0))
        out = dict(best)
        out["reason"] = "多帧花色不稳定，取置信度最高的一帧仅供参考"
        return out

    agreement = 0.0
    if votes:
        majority = max(set(votes), key=votes.count)
        agreement = votes.count(majority) / float(len(votes))
        if majority != color:
            # 聚合结论与多数票打架：色板平均说 A、多数单帧说 B。以色板聚合为准
            # （它用了全部像素证据），但必须把分歧写出来，别让用户当确定结论。
            reason = ("多帧花色结论不一致（多数帧判「%s」，综合色板判「%s」）"
                      % (COLOR_LABELS.get(majority, majority),
                         COLOR_LABELS.get(color, color)))
    elif len(heur) > 1:
        reason = "部分帧未能判定花色"

    palette = [
        {"key": b, "label": _BUCKET_LABELS.get(b, b), "ratio": round(ratio[b], 3)}
        for b in sorted(_CAT_BUCKETS, key=lambda k: -ratio[k])[:3]
        if ratio[b] >= 0.05
    ]
    return {
        "color": color,
        "pattern": pattern,
        "breed": _breed_of(color, pattern),
        "confidence": _confidence_of(ratio, agreement),
        "source": "heuristic",
        "palette": palette,
        "stripe": stripe,
        "shift": round(float(st.get("shift") or 0.0), 1),
        "reason": reason,
        "frames": len(heur),        # 参与聚合的帧数（诊断用）
    }


def detect(im: Image.Image, cropped: bool = False,
           mask: Optional[np.ndarray] = None) -> dict:
    """属性识别总入口：远程（可选）→ 本地方法（legacy / pattern）。

    注意这里**没有** CLIP —— CLIP 由 `engine._AttrClassifier` 持有（它是唯一
    需要 torch 的部分），engine 负责先问 CLIP、低置信才落到这里。这样本模块
    可以在完全不装 torch 的环境里独立运行和被测试。

    本地方法由 `config.ATTR_ENGINE` 决定（2026-11-10，默认 pattern）：
      pattern → tools/pattern_recognize.py 的 `analyze()`（看色板+布局口径）
      legacy  → 本文件的 `analyze()`（色域统计，可回退的旧口径）

    两套输出契约逐字段相同，上层无感。pattern 加载/运行失败时**自动回退
    legacy** —— 一个可选的判定口径不能成为整条识别链的单点故障。
    """
    if getattr(config, "ATTR_API_URL", ""):
        got = _remote(im)
        if got:
            return got
    if str(getattr(config, "ATTR_ENGINE", "pattern") or "").strip().lower() != "legacy":
        got = _pattern_detect(im, cropped=cropped, mask=mask)
        if got:
            return got
        log.warning("ATTR_ENGINE=pattern 不可用，本次回退到本地色域启发式")
    return analyze(im, cropped=cropped, mask=mask)


# pattern 识别器是**按文件路径懒加载**的（2026-11-10）：
#   · tools/ 是脚本目录（没有 __init__.py），按包名 import 依赖 cwd/sys.path；
#   · 只有 `ATTR_ENGINE` 不是 legacy 时才加载，回退路径不付出任何代价；
#   · 部署镜像 `COPY . .` 会把 tools/ 一起带进去，路径用 __file__ 推导。
_PATTERN: dict = {"mod": None, "tried": False}


def _pattern_module():
    """加载 tools/pattern_recognize.py；失败返回 None（调用方回退 legacy）。"""
    if not _PATTERN["tried"]:
        _PATTERN["tried"] = True
        path = Path(__file__).resolve().parent.parent / "tools" / "pattern_recognize.py"
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location("catcampus_pattern", path)
            if spec is None or spec.loader is None:
                raise ImportError(f"无法从 {path} 构造加载器")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _PATTERN["mod"] = mod
        except Exception as e:  # noqa: BLE001
            log.warning("加载 pattern 识别器失败（%s）：%s", path, e)
    return _PATTERN["mod"]


def _pattern_detect(im: Image.Image, cropped: bool, mask) -> Optional[dict]:
    """用 pattern 识别器跑一次；不可用返回 None。

    门控阈值传过去的是**同一批 config**（ATTR_MIN_SHARP / ATTR_MIN_FG /
    ATTR_SHARP_SIZE）—— 换判定口径不该换「什么叫一张能用的照片」。
    """
    mod = _pattern_module()
    if mod is None:
        return None
    params = {
        "min_sharp": float(getattr(config, "ATTR_MIN_SHARP", 10.0)),
        "min_fg": float(getattr(config, "ATTR_MIN_FG", 0.005)),
        "sharp_size": int(getattr(config, "ATTR_SHARP_SIZE", 512)),
    }
    try:
        return mod.analyze(im, cropped=cropped, mask=mask, params=params)
    except Exception as e:  # noqa: BLE001
        log.warning("pattern 识别器运行失败，本次回退到色域启发式：%s", e)
        return None
