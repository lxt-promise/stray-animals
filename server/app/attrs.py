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
from typing import List, Optional

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
    a, b = (a or "").strip(), (b or "").strip()
    if not a or not b or a == "other" or b == "other":
        return None
    if a not in COLOR_LABELS or b not in COLOR_LABELS:
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
    frozenset(("cow", "tortoiseshell")),
    frozenset(("tuxedo", "tortoiseshell")),
    frozenset(("white", "tortoiseshell")),
})


def hard_exclusive(a: str, b: str) -> bool:
    """两个花色是否「物理不可能是同一只猫」—— 比 compatible 更强的结论。

    任一为空 / other / 不在枚举 → False（绝不判死，保守放行）。
    注意方向无关：hard_exclusive(a, b) == hard_exclusive(b, a)。
    """
    a, b = (a or "").strip(), (b or "").strip()
    if not a or not b or a == "other" or b == "other":
        return False
    if a not in COLOR_LABELS or b not in COLOR_LABELS:
        return False
    return frozenset((a, b)) in HARD_EXCLUSIVE

# 色桶（统计用的内部分类）→ 中文，只出现在 palette 里
_BUCKET_LABELS = {
    "white": "白", "black": "黑", "gray": "灰", "orange": "橘",
    "brown": "深棕", "cream": "米黄", "red": "红棕",
}


def _empty(reason: str = "") -> dict:
    return {
        "color": "",
        "pattern": "",
        "breed": "",
        "confidence": 0.0,
        "source": "heuristic",
        "palette": [],
        "stripe": 0.0,
        "reason": reason,
    }


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


def _exposure_shift(v: np.ndarray, weight: np.ndarray) -> float:
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
    """
    p_hi = _wquantile(v, weight, 0.98)
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


def _decide(ratio: dict, stripe: float, dgray: float = 0.0) -> tuple:
    """颜色占比 + 条纹 → (color, pattern)。全是枚举 value。

    dgray = 「暗灰」占比（62 < 亮度 ≤125 的低饱和像素），2026-10-24 新增。
    为什么需要：黑毛在阳光/灯光下反光，亮度落到 60~120，被 _classify 归进
    gray 桶 —— 实测一张奶牛猫照 gray 桶 51%（其中暗灰 28%），黑只占 21%，
    两色调规则（white/black 双门槛）永远够不着，最后判成「灰猫」。
    判定用**有效暗色 dark = black + dgray**、**有效浅色 light = white + 亮灰**，
    原 ratio 只留给 palette 展示。
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
    # ⚠️ red **不**计入暖色（2026-10-25）。
    # 理由是场景先验：真正的红棕色猫极少见（家猫红棕基本就是深橘，落 orange/brown），
    # 而**红色杂物**极常见 —— 渔网、红布、砖墙、红毯、塑料袋，而且经常就在猫旁边
    # 甚至盖在猫身上（检测框裁不掉）。实测一张「白猫坐红渔网」的照片 red 桶 0.30+，
    # warm 被抬到 0.45+，硬生生判成橘猫；同一只猫没渔网就判对。red 留在 palette
    # 里做诊断展示，但不再参与任何判定规则 —— 少一类暖色结论，
    # 换掉「旁边有红色东西就判橘」这个高频灾难，划算。
    warm = orange + brown + cream           # 暖色（橘/棕/奶黄）总量
    has_tabby = stripe >= config.ATTR_STRIPE_MIN
    tabby_like = "tabby" if has_tabby else "solid"

    # 1) 三花（严格）：白 + 鲜明橘 + 黑三色共存。warm 设上限是因为橘猫的
    #    warm 总量更高（0.53+），靠下限挡不住「白胸橘猫」。
    if white >= 0.28 and 0.15 <= warm <= 0.50 and dark >= 0.03 and orange >= 0.08:
        return "calico", "calico"
    # 2) 玳瑁：暗色 + 暖色、几乎没有白，且**没有规则条纹**。
    #    玳瑁是"红黑不规则斑块"，狸花是"规则条纹"—— 同样的颜色分布，
    #    条纹是唯一可靠的区分点，漏掉这条会把狸花全判成玳瑁。
    if dark >= 0.18 and warm >= 0.18 and light < 0.12 and not has_tabby:
        return "tortoiseshell", "tortoiseshell"
    # 3) 黑白两色调（2026-10-24 重写）：有效浅色与有效暗色都够量、且暖色少、
    #    且不是条纹 → 奶牛 / 燕尾服。分界从「白 vs 黑谁多」改成 light≥0.22：
    #    民间「奶牛猫」指黑白斑块猫，黑多白少也是奶牛；只有白块很小的
    #    （白围脖白爪）才是燕尾服。实测 4 张奶牛照 light 0.26~0.39 全部落对。
    if not has_tabby and warm < 0.25 and (
            (light >= 0.15 and dark >= 0.16) or
            (white >= 0.45 and dark >= 0.08)):    # 白底 + 小块黑斑（大多白奶牛）
        return ("cow" if (light >= 0.22 or light >= dark) else "tuxedo"), "cow"
    # 4) 三花（宽松，兜底随机 mosaic 那种白块偏少的构造）
    if white >= 0.16 and dark >= 0.12 and warm >= 0.14:
        return "calico", "calico"
    # 5) 白 + 暖色（橘白 / 白橘）
    if white >= 0.22 and warm >= 0.18:
        return "orange", tabby_like
    # 6) 暖色主导：鲜明橘够多才是橘猫，否则按条纹判狸花。
    #    橘色占比门槛（0.15）不能省：狸花猫的底毛是浅黄褐（落 cream 桶）+ 黑条纹，
    #    暖色总量很高但几乎没有"鲜明橘"，靠总量判会把狸花全判成橘猫。
    if warm >= 0.30 and warm >= gray:
        if orange >= 0.15:
            return "orange", tabby_like
        return ("tabby", "tabby") if has_tabby else ("orange", "solid")
    # 7) 有真条纹且暗色够量 → 狸花。必须在单色规则**之前**：狸花猫的黑条纹 +
    #    阴影经常把 gray 桶堆到 0.40+（实测两张狸花 gray 0.30~0.45），
    #    先判单色会把它们全吃成「灰猫」。
    if has_tabby and dark >= 0.12:
        return "tabby", "tabby"
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


def _stats_of(rgb: Image.Image, cropped: bool) -> Optional[dict]:
    """算出**中间统计量**，不做最终判定。返回 None = 有效像素不足。

    单独抽出来是为了多帧聚合（见 `merge_stats`）：视频里每一帧都能算出这个
    dict，把多帧的 ratio 加权平均、stripe 取中位数，再统一走一次 _decide，
    比「每帧各判一次然后挑置信度最高的」稳得多 —— 后者等于让某一帧单独
    做决定，糊帧/逆光帧照样能一票定生死。
    """
    small = rgb.resize((_SIZE, _SIZE), Image.BILINEAR)
    hsv = np.asarray(small.convert("HSV"))
    hd = hsv[..., 0].astype(np.float32) * (360.0 / 255.0)
    s = hsv[..., 1].astype(np.float32)
    v = hsv[..., 2].astype(np.float32)

    # 整图模式给边缘降权；裁剪模式（检测框已紧贴猫体）全权重，不削耳朵和尾巴
    weight = (np.ones((_SIZE, _SIZE), dtype=np.float64) if cropped
              else _center_weight(_SIZE, _SIZE))

    shift = _exposure_shift(v, weight)
    idx = _classify(hd, s, v, shift)

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

    # 条纹检测：非裁剪图先内缩 10% 再算梯度，避开照片边框/水印造成的假边缘
    g = np.asarray(small.convert("L"), dtype=np.float32)
    if not cropped:
        pad = int(_SIZE * 0.10)
        g = g[pad:_SIZE - pad, pad:_SIZE - pad]
    stripe = _stripe_score(g)

    return {"ratio": ratio, "dgray": dgray, "stripe": stripe,
            "coverage": valid / total, "shift": shift}


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
    stripe = float(np.median([float(x.get("stripe") or 0.0) for x in ok]))
    shift = float(np.median([float(x.get("shift") or 0.0) for x in ok]))
    coverage = tw / len(ok)
    return {"ratio": ratio, "dgray": dgray, "stripe": stripe,
            "coverage": coverage, "shift": shift, "frames": len(ok)}


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


def analyze(im: Image.Image, cropped: bool = False) -> dict:
    """本地启发式属性分析。

    cropped=True 表示传进来的是检测框裁出的猫体，已经紧贴主体 ——
    此时不再套中央椭圆（否则会削掉耳朵/尾巴），也不内缩边框。
    """
    try:
        rgb = im.convert("RGB")
    except Exception as e:  # noqa: BLE001
        return _empty("图片无法解析：%s" % e)

    if rgb.size[0] < 8 or rgb.size[1] < 8:
        return _empty("图片太小（%dx%d）" % rgb.size)

    st = _stats_of(rgb, cropped)
    if st is None:
        # 覆盖率不足时 _stats_of 没返回 ratio，这里重算一次只为给出可读的原因
        small = rgb.resize((_SIZE, _SIZE), Image.BILINEAR)
        hsv = np.asarray(small.convert("HSV"))
        hd = hsv[..., 0].astype(np.float32) * (360.0 / 255.0)
        s = hsv[..., 1].astype(np.float32)
        v = hsv[..., 2].astype(np.float32)
        weight = (np.ones((_SIZE, _SIZE), dtype=np.float64) if cropped
                  else _center_weight(_SIZE, _SIZE))
        idx = _classify(hd, s, v)
        counts = np.bincount(idx.ravel(), weights=weight.ravel(),
                             minlength=len(_BUCKETS))
        total = float(counts.sum()) or 1.0
        valid = total - float(counts[_OTHER])
        return _empty("画面里猫体区域不足（有效占比 %d%%，需 %d%%）"
                      % (int(round(100.0 * valid / total)),
                         int(round(100 * config.ATTR_MIN_COVERAGE))))

    ratio, dgray, stripe = st["ratio"], st["dgray"], st["stripe"]
    color, pattern = _decide(ratio, stripe, dgray)
    if not color:
        return _empty("颜色不集中（最大色占比 %d%%），无法判断花色"
                      % int(round(100 * max(ratio[k] for k in _CAT_BUCKETS))))

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
        return None

    st = merge_stats([r["_stats"] for r in heur])
    if st is None:                                  # 理论到不了（heur 都有 ratio）
        return None

    ratio, dgray, stripe = st["ratio"], st["dgray"], st["stripe"]
    color, pattern = _decide(ratio, stripe, dgray)

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


def detect(im: Image.Image, cropped: bool = False) -> dict:
    """属性识别总入口：远程（可选）→ 本地启发式。

    注意这里**没有** CLIP —— CLIP 由 `engine._AttrClassifier` 持有（它是唯一
    需要 torch 的部分），engine 负责先问 CLIP、低置信才落到这里。这样本模块
    可以在完全不装 torch 的环境里独立运行和被测试。
    """
    if getattr(config, "ATTR_API_URL", ""):
        got = _remote(im)
        if got:
            return got
    return analyze(im, cropped=cropped)
