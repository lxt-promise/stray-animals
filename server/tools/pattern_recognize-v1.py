"""复现「看图说话」式猫花色识别 —— 独立实现，不依赖 app/ 里的任何模块。

背景：多模态大模型识别那张奶牛猫时的推理过程是三步：

  0. 找到猫：先看「猫在画面哪里」，把视线聚焦到猫体上，
     背景（白墙、黑窗、灯光）不参与毛色判断；
  1. 全局调色板：再看猫身上有哪些毛色、各占多少
     （白 / 黑 / 灰 / 暖色），干扰物（人手、红袖子）是肤色/暖色，
     不属于猫的黑白毛色体系，直接归入暖色桶、不参与黑白判定；
  2. 空间布局：这些色块长在什么部位 —— 头顶和耳朵黑不黑、
     口鼻/胸口白不白、背部有没有大块黑斑、爪子是不是「白手套」；
  3. 规则判定：黑白两色成片共存 → 双色猫；白色可观 → 奶牛，
     白块很小（白围脖白爪）→ 燕尾服；暖色参与三色 → 三花；
     明暗周期性条纹 → 狸花；单色占绝对多数 → 纯色猫。

本脚本用 numpy + PIL + 项目自带 YOLO / u2netp 把这三步逐条翻译成代码：

  第 0 步 → models/yolov8n.onnx 检测猫体（COCO class 15），裁出猫体 crop，
           没检测到时退回整图 + 中心加权；
  第 0.5 步 → models/u2netp.onnx 抠图，统计只在猫毛像素上做，
           背景/地面/阴影不进调色板；
  第 1 步 → HSV 逐像素色桶分类（白/黑/灰/鲜明橘/棕灰）+ 曝光归一化
           （V 轴按主角亮度 p98 缩放，夜里白猫不再判成纯黑）；
  第 2 步 → 上/中/下三条水平带的分部位色占比 + 8×8 瓦片「斑块度」；
  第 3 步 → 规则表输出花色结论与证据；
  第 4 步 → 组装三特征输出：品种（外貌花色归类）/ 毛色（色桶构成，
           含低光染色的上下文修正）/ 花纹（条纹/斑块/纯色，与品种
           共享证据链）。

在 20 张实拍标注图（E:\\Agent\\worker\\东南大学-猫\\原图）上的实测：
  20/20（见 tools/test_pattern_recognize.py），走 app 真实调用路径
  （同一 YOLO 检测框 + 同一张掩膜）同样 20/20，16 张标准照 16/16
  —— 对比 app/attrs.py 的 legacy 口径为 18/20 与 15/16。

  2026-11-10 之前唯一失败的「三花猫.jpg」（人手捧幼猫、抠图把手臂算成
  主体）已修：暖色块过大时不再整块放弃剔除，而是只剔其中**平滑肤色**
  像素（皮肤梯度 18~24 vs 毛流 32~38），白身不再被手臂的暖色盖过。

  2026-11-11：同一只黑白猫的两张裁剪（`奶牛猫-有人手干扰-裁剪/-裁剪2`）
  一张奶牛、一张三花。根因是宽裁剪把窗台和两只手一起框进来，暖光染色的
  白毛被判成「鲜明橘」。修法见 decide() 规则 0：白门槛改用「白 + 暖白」，
  并要求真黑块 ≥0.12（四张真三花的黑都 ≤0.058）。

怎么被服务端调用
----------------
app/attrs.py 的 `detect()` 在 `ATTR_ENGINE=pattern`（默认）时调用本文件的
`analyze(im, cropped, mask, params)` —— 输出与 attrs 契约逐字段对齐，
上层无感；加载/运行失败自动回退 legacy。CLI 与回归测试则用 `recognize(path)`。

已知边界（不做硬猜，直说）：
  · 人手/手臂大面积遮挡时靠「边缘连通 + 肤色平滑」剔除，剔除量受 28% 上限
    约束 —— 手臂占掉半个画面时仍可能把橘色抬高；
  · 极端欠曝（猫只占画面 5%、夜里）时白猫与灰猫难分，靠「规则 4b 救援」
    兜底，本质仍依赖亮度分布；
  · 逐像素色域法只有颜色信息，同一只猫换个光就换一组数字 —— 所以阈值
    全部标定在「掩膜加权 + 曝光归一化之后」的口径上，改动颜色链路必须回归。

用法：
  env\\Scripts\\python.exe tools\\pattern_recognize.py <图片路径> [--json]
  env\\Scripts\\python.exe tools\\test_pattern_recognize.py [图片目录]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np  # type: ignore
from PIL import Image  # type: ignore

# 分析分辨率：crop 缩到 128×128 做色桶统计，CPU 毫秒级
SIZE = 128

# 色桶编号：0 白 1 黑 2 灰 3 鲜明橘 4 棕灰底毛 5 其他
#
# 暖色拆成两桶的理由（实测标定数据）：橘猫毛 S 中位 66~131，
# 而狸花/深棕底毛只有 42~45，白猫在钠灯下的偏黄毛 S 只有 28~40。
# 合成一个「暖」桶时，橘猫、狸花、暖光下的白猫全挤在一起（暖 0.4~0.9 无法区分）；
# 拆开后「鲜明橘」只在真正的橘毛/橘斑上出现，是橘猫与三花的主证据，
# 低饱和那一档则代表「棕灰底毛」，是狸花的主证据。
WHITE, BLACK, GRAY, ORANGE, BROWN, OTHER = range(6)
BUCKET_NAMES = ("白", "黑", "灰", "鲜明橘", "棕灰", "其他")

# ---- 可用性 / 干扰剔除的可调参数 -------------------------------------------
# app 侧（app/attrs.py）会把自己 config 里的同名项传进来，保持两条链路同一把尺子；
# 本文件单独跑 CLI 时用这些默认值，因此**不依赖 app/**。
DEFAULTS: Dict[str, float] = {
    "min_sharp": 10.0,     # 前景 Laplacian 方差下限（512 长边口径，与 ATTR_MIN_SHARP 同值）
    "min_fg": 0.005,       # 前景像素占比下限，低于它 = 画面里几乎没有猫
    "sharp_size": 512,     # 清晰度检测的长边
    "skin_cap": 0.28,      # 暖色块过大时，最多剔除多少「平滑肤色」（人手/手臂）
    "warm_cap": 0.40,      # 暖色块本身占多少以内才允许「整块按肤色删」
    "skin_grad": 25.0,     # 皮肤平滑判据：局部梯度均值上限（毛流/条纹约 32~38）
}


# YOLO 检测参数（与 app/engine.py 的 _Detector 同口径）
CAT_CLASS = 15
DETECT_CONF = 0.25
DETECT_RETRY_CONF = 0.18     # 暗图提亮后的重试阈值
DETECT_PAD = 0.08            # 检测框外扩比例（抠图取景用）
_MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "yolov8n.onnx"
_MATING_PATH = Path(__file__).resolve().parent.parent / "models" / "u2netp.onnx"
_sess: Dict[str, Any] = {"sess": None, "size": 640, "tried": False}
_mat: Dict[str, Any] = {"sess": None, "tried": False}
# u2netp 预处理口径（ImageNet 归一化，输入 320×320）
MAT_SIZE = 320
MAT_MEAN = np.array((0.485, 0.456, 0.406), dtype=np.float32)
MAT_STD = np.array((0.229, 0.224, 0.225), dtype=np.float32)


# ------------------------------------------------------------- 第 0 步：定位
def _detector():
    """懒加载 YOLO ONNX；失败返回 None（退回整图分析，不拦主流程）。"""
    if not _sess["tried"]:
        _sess["tried"] = True
        if _MODEL_PATH.exists():
            try:
                import onnxruntime as ort  # type: ignore
                _sess["sess"] = ort.InferenceSession(
                    str(_MODEL_PATH), providers=["CPUExecutionProvider"])
                sh = _sess["sess"].get_inputs()[0].shape
                _sess["size"] = int(sh[-1]) if isinstance(sh[-1], int) else 640
            except Exception as e:  # noqa: BLE001
                print(f"检测模型加载失败，退回整图分析：{e}", file=sys.stderr)
    return _sess["sess"]


def _letterbox(im: Image.Image, size: int) -> Image.Image:
    """保持长宽比缩放并居中补灰边（YOLO 输入口径）。"""
    w, h = im.size
    s = size / max(w, h)
    nw, nh = min(size, max(1, int(round(w * s)))), min(size, max(1, int(round(h * s))))
    canvas = Image.new("RGB", (size, size), (128, 128, 128))
    canvas.paste(im.resize((nw, nh), Image.BICUBIC),
                 ((size - nw) // 2, (size - nh) // 2))
    return canvas


def _box_to_xyxy(b: Any, w: int, h: int, size: int) -> List[int]:
    """cxcywh（输入坐标系）→ 原图 xyxy，按 letterbox 逆变换还原。"""
    cx, cy, bw, bh = (float(v) for v in b[:4])
    if max(cx, cy, bw, bh) <= 1.5:                      # 归一化导出
        cx, cy, bw, bh = cx * size, cy * size, bw * size, bh * size
    s = size / max(w, h)
    px, py = (size - w * s) / 2.0, (size - h * s) / 2.0
    x1, y1 = (cx - bw / 2 - px) / s, (cy - bh / 2 - py) / s
    x2, y2 = (cx + bw / 2 - px) / s, (cy + bh / 2 - py) / s
    x1, x2 = max(0, min(w, x1)), max(0, min(w, x2))
    y1, y2 = max(0, min(h, y1)), max(0, min(h, y2))
    return [int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2))]


def _pick_subject(boxes: List[List[int]], confs: List[float],
                  iou_thr: float = 0.45) -> int:
    """NMS 去重后取面积最大的框（画面主体）。"""
    order = sorted(range(len(boxes)), key=lambda i: -confs[i])
    kept = []
    for i in order:
        ok = True
        for j in kept:
            ax1, ay1, ax2, ay2 = boxes[i]
            bx1, by1, bx2, by2 = boxes[j]
            ix = max(0, min(ax2, bx2) - max(ax1, bx1))
            iy = max(0, min(ay2, by2) - max(ay1, by1))
            inter = ix * iy
            union = ((ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter)
            if union > 0 and inter / union > iou_thr:
                ok = False
                break
        if ok:
            kept.append(i)
    if not kept:
        return -1
    return max(kept, key=lambda i: (boxes[i][2] - boxes[i][0]) *
                                   (boxes[i][3] - boxes[i][1]))


def _detect_once(im: Image.Image,
                 conf_thr: float) -> Tuple[Optional[List[int]], float]:
    """单趟检测，返回 (box|None, conf)。"""
    sess = _detector()
    if sess is None:
        return None, 0.0
    size = int(_sess["size"])
    w, h = im.size
    a = np.asarray(_letterbox(im.convert("RGB"), size), dtype=np.float32) / 255.0
    x = np.transpose(a, (2, 0, 1))[None, ...]
    out = np.asarray(sess.run(None, {sess.get_inputs()[0].name: x})[0])
    if out.ndim == 3:
        out = out[0]
    if out.shape[0] < out.shape[-1]:
        out = out.T
    if out.shape[-1] < 6:
        return None, 0.0
    raw, scores = out[:, :4], out[:, 4:]
    cls, conf = scores.argmax(1), scores.max(1)
    keep = np.where((conf > conf_thr) & (cls == CAT_CLASS))[0]
    if not len(keep):
        return None, 0.0
    boxes = [_box_to_xyxy(raw[i], w, h, size) for i in keep]
    confs = [float(conf[i]) for i in keep]
    idx = _pick_subject(boxes, confs)
    if idx < 0:
        return None, 0.0
    # 外扩 8% 后返回：抠图/统计都用这个框。
    # ⚠️ 2026-11-10 实测：改成「紧贴框」会让三张「身体白头三花」的抠图
    # 取景变化、调色板整体偏移（白 .23→.31、棕灰 .48→.26），判定从三花
    # 变 unknown —— 批内稳定比单张边界更重要，所以保留外扩。
    b = boxes[idx]
    dx = int(round((b[2] - b[0]) * DETECT_PAD))
    dy = int(round((b[3] - b[1]) * DETECT_PAD))
    return [max(0, b[0] - dx), max(0, b[1] - dy),
            min(w, b[2] + dx), min(h, b[3] + dy)], confs[idx]


def _gamma_lift(im: Image.Image, target: float = 150.0) -> Optional[Image.Image]:
    """暗图 gamma 提亮（低光检测重试用），正常曝光返回 None。"""
    mean = float(np.asarray(im.convert("L").resize((64, 64)), dtype=np.float32).mean())
    if mean >= 120.0 or mean <= 1.0:
        return None
    gamma = max(0.45, min(1.0, np.log(target / 255.0) / np.log(mean / 255.0)))
    if gamma >= 0.95:
        return None
    lut = [min(255, int(round(((i / 255.0) ** gamma) * 255.0))) for i in range(256)]
    return im.convert("RGB").point(lut * 3)


def locate_cat(im: Image.Image) -> Tuple[Optional[List[int]], float, str]:
    """检测画面主体猫，返回 (box|None, conf, reason)。夜间提亮重试一次。"""
    box, conf = _detect_once(im, DETECT_CONF)
    if box is not None:
        return box, conf, ""
    lifted = _gamma_lift(im)
    if lifted is not None:
        box, conf = _detect_once(lifted, DETECT_RETRY_CONF)
        if box is not None:
            return box, conf, "lowlight-retry"
    return None, 0.0, "模型没有识别到猫体"


def _matting():
    """懒加载 u2netp 抠图模型；失败返回 None。"""
    if not _mat["tried"]:
        _mat["tried"] = True
        if _MATING_PATH.exists():
            try:
                import onnxruntime as ort  # type: ignore
                _mat["sess"] = ort.InferenceSession(
                    str(_MATING_PATH), providers=["CPUExecutionProvider"])
            except Exception as e:  # noqa: BLE001
                print(f"抠图模型加载失败，退回整框统计：{e}", file=sys.stderr)
    return _mat["sess"]


def foreground_mask(crop: Image.Image):
    """u2netp 前景显著图 → 128×128 软掩膜（0~1），失败返回 None。

    对应我看图时的「只看猫身上的毛」：地面、背景、甚至人手虽然落在检测
    框里，但不是猫毛，不该参与调色板统计。掩膜作为**统计权重**使用，
    软边保留（毛边不硬切），背景严格为 0。

    min-max 归一化再取阈值：u2netp 输出是相对显著度，同一张图里
    最大值代表「最像前景的像素」，直接阈值化会把整张图判成背景或前景。
    """
    sess = _matting()
    if sess is None:
        return None
    try:
        arr = np.asarray(crop.convert("RGB").resize((MAT_SIZE, MAT_SIZE), Image.LANCZOS),
                         dtype=np.float32) / 255.0
        arr = (arr - MAT_MEAN) / MAT_STD
        x = np.transpose(arr, (2, 0, 1))[None, ...].astype(np.float32)
        out = np.asarray(sess.run(None, {sess.get_inputs()[0].name: x})[0], dtype=np.float32)
        out = out.reshape(MAT_SIZE, MAT_SIZE)
        lo, hi = float(out.min()), float(out.max())
        if hi - lo > 1e-6:
            out = (out - lo) / (hi - lo)
        m = np.asarray(Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))
                       .resize((SIZE, SIZE), Image.BILINEAR), dtype=np.float32) / 255.0
        if float((m >= 0.5).mean()) < 0.02:     # 前景太小 = 抠图失败，退回整框
            return None
        return m.astype(np.float64)
    except Exception as e:  # noqa: BLE001 —— 抠图是加分项，失败不拦识别
        print(f"抠图失败，退回整框统计：{e}", file=sys.stderr)
        return None


# ------------------------------------------------------------- 第 1 步：调色板
def center_weight() -> np.ndarray:
    """中心高斯权重（仅整图兜底模式用：crop 已紧贴猫体，不再压边缘）。"""
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    c = (SIZE - 1) / 2.0
    d = ((xx - c) / (SIZE * 0.42)) ** 2 + ((yy - c) / (SIZE * 0.42)) ** 2
    return np.exp(-0.5 * d)


def exposure_gain(v: np.ndarray, weight: np.ndarray) -> float:
    """曝光归一化增益：用**主体内**亮度 p98 做锚点，返回 V 的乘法缩放系数。

    为什么必须归一化（实测 19 张标定图）：白毛/黑毛的分界是绝对亮度，
    夜间白猫的白毛 V 只有 90~150，整桶掉进 gray，结论从「纯白」变成
    「纯黑」；暗光下的橘毛饱和度掉到 S<60，整只橘猫落进 other。

    锚点必须在**猫体 crop 内**取：整图口径会被夜景灯光、白色墙面污染
    （实测 白猫-黑天 p98 被一盏灯顶满，增益算出来 ≈1.0，等于没归一化）。
    crop 内 p98 就是「这只猫最亮的毛有多亮」—— 夜里低、白天高，
    把 V 轴乘以 ref/p98 等于把每只猫对齐到标准曝光。

    用乘法而不是平移：乘法保持「白毛比灰毛亮、灰毛比黑毛亮」的相对结构。
    增益限制在 [0.75, 2.6]：过曝图最多压暗 25%，欠曝图最多提亮 1.6 档。"""
    vv, ww = v.ravel(), weight.ravel()
    order = np.argsort(vv, kind="stable")
    vs, ws = vv[order], ww[order]
    cw = np.cumsum(ws)
    if cw[-1] <= 0:
        return 1.0
    p98 = float(vs[min(vs.size - 1, int(np.searchsorted(cw, cw[-1] * 0.98)))])
    if p98 <= 1:
        return 1.0
    return float(min(2.6, max(0.75, 235.0 / p98)))


def classify_buckets(im: Image.Image, weight: np.ndarray) -> np.ndarray:
    """逐像素归入 6 个色桶，返回 (SIZE, SIZE) int8 编号图。

    阈值按猫毛的典型 HSV 定。肤色/红袖/橘毛都是暖色相 —— 这正是
    「人手干扰不改变黑白结论」的原因：它落进暖色桶（橘/棕灰）。
    暖色下限 35 而不是 60：暗光/逆光下的橘毛饱和度会掉到 30~60
    （实测 橘猫3 有 40% 像素 S 在 30~60），门槛 60 会把整只橘猫漏进 other；
    上界 65 把「鲜明橘」与「棕灰底毛」分开（见色桶编号注释）。

    分类前先做曝光归一化（exposure_gain）：只缩放 V，不动 S/H ——
    HSV 里 S 是比值、H 是色相角，对整体亮度天然免疫，只有 V 会漂。"""
    hsv = np.asarray(im.convert("HSV")).astype(np.float32)
    h = hsv[..., 0] * (360.0 / 255.0)   # 色相 0~360
    s = hsv[..., 1]                     # 饱和 0~255
    v = hsv[..., 2]                     # 明度 0~255

    gain = exposure_gain(v, weight)
    v = np.clip(v * gain, 0.0, 255.0)

    white = (v >= 175) & (s <= 60)
    black = v <= 70
    gray = (s <= 50) & ~white & ~black
    hue_ok = (h >= 5) & (h <= 60)
    orange = hue_ok & (s >= 65)                       # 鲜明橘：橘毛/橘斑
    brown = hue_ok & (s >= 35) & (s < 65)             # 棕灰底毛：狸花底毛

    idx = np.full((SIZE, SIZE), OTHER, dtype=np.int8)
    for i, m in enumerate((white, black, gray, orange, brown)):
        idx[m] = i
    return idx


def weighted_ratio(idx: np.ndarray, weight: np.ndarray) -> Dict[int, float]:
    """加权色桶占比（总和为 1，含 other）。"""
    counts = np.bincount(idx.ravel(), weights=weight.ravel(), minlength=len(BUCKET_NAMES))
    total = float(counts.sum())
    if total <= 0:      # 掩膜全空 / 干扰剔除把权重清零 → 全 0，由调用方当「判不出」
        return {i: 0.0 for i in range(len(BUCKET_NAMES))}
    return {i: float(counts[i]) / total for i in range(len(BUCKET_NAMES))}


def drop_border_warm(idx: np.ndarray,
                     rgb_small: Image.Image,
                     params: Optional[Dict[str, float]] = None) -> Tuple[np.ndarray, float]:
    """剔除「从画面边缘伸进来」的连通暖色块 —— 人手、衣袖等干扰物。

    对应我看图时「忽略人手干扰」的空间推理：手是**从画面外侧进入、
    与猫体相连**的肤色区域，而猫毛色块不会单独从边框长出来。

    ⚠️ 只靠「边缘连通 + 暖色」会误删猫毛（实测深棕狸花猫的毛色
    H25/S67 与人手 H27/S71 几乎一致，且猫毛同样连到 crop 边框，
    39% 的猫体被当成手剔掉）。所以必须再加一条**肤色专属**证据：
      ① 色相窄带 5~30（肤色/红棕色，排除偏黄的橘毛 H≥31）；
      ② 中位饱和 S≥60（皮肤高饱和，狸花底毛 S 只有 45~55）；
      ③ 纹理平滑：梯度均值 <30（皮肤平滑，毛有条纹/毛流，实测
         人手 18~24 vs 猫毛 32~38）；
      ④ 占比 ≤22%。

    2026-11-10 新增「只删皮肤子集」：三花猫.jpg（手捧幼猫）的暖色块
    连成一片、占 68%，④ 直接整条放弃 —— 手臂没被剔除，白身被橘色盖过，
    判成橘猫。人手与猫毛的区别在**纹理**，不在面积：暖色块过大时，
    改为只剔除其中「局部梯度 < `skin_grad` 的平滑像素」，猫毛的条纹
    纹理保留。剔除量仍受 `skin_cap` 约束（橘猫-遮挡0 实测 44% 都是
    平滑暖色，但那更像整身橘毛的高光，超过上限就不动它）。

    返回 (新色桶图, 剔除像素占比)。"""
    p = dict(DEFAULTS)
    p.update(params or {})
    warm = (idx == ORANGE) | (idx == BROWN)
    visited = np.zeros_like(warm, dtype=bool)
    stack = []
    h, w = warm.shape
    for x in range(w):
        for y in (0, h - 1):
            if warm[y, x]:
                stack.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if warm[y, x]:
                stack.append((y, x))
    while stack:
        y, x = stack.pop()
        if visited[y, x] or not warm[y, x]:
            continue
        visited[y, x] = True
        if y > 0:
            stack.append((y - 1, x))
        if y < h - 1:
            stack.append((y + 1, x))
        if x > 0:
            stack.append((y, x - 1))
        if x < w - 1:
            stack.append((y, x + 1))

    removed = float(visited.mean())
    if removed <= 0:
        return idx, 0.0

    hsv = np.asarray(rgb_small.convert("HSV")).astype(np.float32)
    hue = hsv[..., 0] * (360.0 / 255.0)
    sat = hsv[..., 1]
    gray = np.asarray(rgb_small.convert("L"), dtype=np.float32)
    grad = np.zeros_like(gray)
    grad[1:-1, 1:-1] = (np.abs(np.diff(gray, axis=0))[:-1, 1:-1] +
                        np.abs(np.diff(gray, axis=1))[1:-1, :-1])

    # 先判「整块像不像皮肤」：不像就一个像素都不删（这是自己的毛色）。
    # 三条同时成立才算肤色：色相窄带 5~30 / 中位饱和 ≥60 / 纹理平滑 <30。
    mh, ms, mt = (float(np.median(hue[visited])), float(np.median(sat[visited])),
                  float(grad[visited].mean()))
    if not (5.0 <= mh <= 30.0 and ms >= 60.0 and mt < 30.0):
        return idx, 0.0

    # 像皮肤、但整块占得太少？整块删（原有标定值 40%）。
    # 40% 不能再收紧：收到 22% 会让 22%~40% 的暖色块从「整块移除」降级成
    # 「部分移除」，实测把 奶牛猫-有人手干扰（两只）从 cow 推成 calico。
    if removed <= float(p["warm_cap"]):
        keep = visited
        cap = float(p["warm_cap"])
    else:
        # 超过 40%（手 + 猫身连成一片）：只删其中**平滑**的肤色像素。
        # 猫毛有毛流/条纹（梯度 32~38），皮肤是平的（18~24）。
        # 整块皮肤判据仍然要求成立 —— 否则「棕毛多、橘斑少」的玳瑁加白
        # （三花3 实测：中位饱和不足 60）会连真橘斑一起被删掉。
        keep = (visited & (hue >= 5.0) & (hue <= 30.0) & (sat >= 60.0)
                & (grad < float(p["skin_grad"])))
        cap = float(p["skin_cap"])
    removed = float(keep.mean())
    if removed <= 0 or removed > cap:
        return idx, 0.0

    out = idx.copy()
    out[keep] = OTHER
    return out, float(keep.mean())


# ------------------------------------------------------------- 第 2 步：布局
def band_report(idx: np.ndarray,
                weight: np.ndarray) -> Dict[str, Dict[str, float]]:
    """上/中/下三条水平带的黑、白占比 → 对应「头顶/背部、躯干、四肢」。
    猫是水平动物，黑白斑块的纵向分布本身就携带部位信息。
    weight 全为 0 的带（被 drop_noncat_bands 剔掉）给 0，不做除零。"""
    out = {}
    names = ("上1/3(头/背)", "中1/3(躯干)", "下1/3(腹/爪)")
    bh = SIZE // 3
    for i, name in enumerate(names):
        sl = slice(i * bh, SIZE if i == 2 else (i + 1) * bh)
        sub, w = idx[sl], weight[sl]
        t = float(w.sum())
        if t <= 0:
            out[name] = {"black": 0.0, "white": 0.0}
            continue
        out[name] = {
            "black": float(w[sub == BLACK].sum()) / t,
            "white": float(w[sub == WHITE].sum()) / t,
        }
    return out


def patchiness(idx: np.ndarray, weight: np.ndarray) -> float:
    """斑块度 0~1：8×8 瓦片里「单一色调占优（≥70%）」的瓦片占比。

    奶牛猫的物理本质是黑白**成片**：每片瓦片要么基本全白、要么基本全黑；
    而一只灰猫的光影渐变会让每块瓦片都黑白混杂。这是「双色」和
    「单色明暗」的关键区分，也是我看图时「黑白大块斑块」判断的量化。"""
    t = 16  # 128/8
    tiles_i = idx.reshape(8, t, 8, t).transpose(0, 2, 1, 3).reshape(64, -1)
    tiles_w = weight.reshape(8, t, 8, t).transpose(0, 2, 1, 3).reshape(64, -1)
    good = mono = 0
    for ti, tw in zip(tiles_i, tiles_w):
        if tw.sum() <= 0:
            continue
        bw = (tw[ti == BLACK].sum() + tw[ti == WHITE].sum()) / tw.sum()
        if bw < 0.3:
            continue        # 黑白占比过低的瓦片（遮挡物/阴影）不计入分母
        good += 1
        fb = tw[ti == BLACK].sum() / max(tw[ti == BLACK].sum() + tw[ti == WHITE].sum(), 1e-6)
        if bw >= 0.5 and (fb >= 0.7 or fb <= 0.3):
            mono += 1
    return mono / good if good else 0.0


def stripe_score(im: Image.Image, drop: Optional[np.ndarray] = None) -> float:
    """条纹显著度 0~1：明暗沿主方向的**周期性交替**带数。

    狸花条纹有 5 条以上明暗带；奶牛斑块边界只有 1~3 条。
    做法：取灰度图，沿梯度更强的方向逐行去趋势（减低频），
    数符号交变次数 —— 交变多 → 周期条纹，而非斑块边界。
    drop（被剔除的干扰物）区域填中位灰：衣袖/窗框的边缘不再贡献假交变。"""
    g = np.asarray(im.convert("L"), dtype=np.float32)
    if drop is not None:
        g = np.where(drop, float(np.median(g)), g)
    ex = float(np.abs(np.diff(g, axis=1)).mean())
    ey = float(np.abs(np.diff(g, axis=0)).mean())
    if max(ex, ey) < 8.0:
        return 0.0
    rows = g if ex >= ey else g.T
    k = max(4, rows.shape[1] // 8)
    ker = np.ones(k, dtype=np.float32) / k
    bands = []
    for row in rows[::8]:
        if row.size < 2 * k + 2:
            continue
        r = row - np.convolve(row, ker, mode="same")
        r = r[k:-k]
        if r.size < 4:
            continue
        bands.append(int(np.sum(np.diff(np.sign(r)) != 0)) / 2.0)
    if not bands:
        return 0.0
    return min(1.0, float(np.median(bands)) / 9.0)


# ------------------------------------------------------------- 第 3 步：判定
def warm_white(rgb_small: Image.Image, weight: np.ndarray) -> float:
    """「暖白」占比：亮度已在白毛区间、但饱和度被灯光染高一点点的那部分。

    为什么单列一项而不放宽白桶（2026-11-10，实测三花猫.jpg）：
      白毛在暖光/室内灯下 S 会从 ~20 染到 60~80，`classify_buckets` 的白
      只收 S≤60，这部分白毛全部掉进「棕灰/鲜明橘」—— 一只白肚皮三花猫
      统计出来白只有 0.09、鲜明橘 0.68，被规则 2 判成橘猫。
      把白桶的 S 上限直接放到 80 会让**白墙/浅色床单**混进白（实测玳瑁
      棚拍照白从 0.03 涨到 0.35 直接改判），所以只在三花判定里并入白。

    口径与 app/attrs.py 的 `pale` 一致（V≥175、S 60~85、H 15~70），
    只是这里作用于**曝光归一化之后**的 V。"""
    hsv = np.asarray(rgb_small.convert("HSV")).astype(np.float32)
    h = hsv[..., 0] * (360.0 / 255.0)
    s = hsv[..., 1]
    v = hsv[..., 2]
    v = np.clip(v * exposure_gain(v, weight), 0.0, 255.0)
    sel = (h >= 15.0) & (h <= 70.0) & (s > 60.0) & (s <= 85.0) & (v >= 175.0)
    total = float(weight.sum())
    if total <= 0:
        return 0.0
    return float(weight[sel].sum()) / total


def brown_dark(rgb_small: Image.Image, idx: np.ndarray, weight: np.ndarray) -> float:
    """「暗棕」占比：落在棕灰桶、但亮度很低（V<110）的那部分。

    为什么需要它（2026-11-10，标准照实测）：棚拍/柔光下的**黑块**不是纯黑，
    而是带反光的深棕（三花猫1 黑只有 .005、灰 .05，但暗棕 .043；
    狸花1 暗棕高达 .256）。只数 black+gray 会把「三色/条纹」的暗部证据
    全部漏掉 —— 三张标准照因此从三花/狸花掉进 unknown / 橘猫。

    反例保护：真正的橘猫没有暗棕（橘猫1/2 实测 0.000），因为橘毛再暗
    也还是暖亮色；所以这个量能把「橘猫」和「带深色斑纹的橘系」分开。"""
    hsv = np.asarray(rgb_small.convert("HSV")).astype(np.float32)
    v = np.clip(hsv[..., 2] * exposure_gain(hsv[..., 2], weight), 0.0, 255.0)
    sel = (idx == BROWN) & (v < 110.0)
    total = float(weight.sum())
    if total <= 0:
        return 0.0
    return float(weight[sel].sum()) / total


def decide(r: Dict[int, float], bands: Dict[str, Dict[str, float]],
           patch: float, stripe: float, pale: float = 0.0,
           brown_dark: float = 0.0) -> Tuple[str, str, List[str]]:
    """规则表：输入全局占比 / 分带占比 / 斑块度 / 条纹分，
    返回 (枚举值, 中文名, 证据说明列表)。规则顺序即优先级。

    阈值全部来自 19 张标定实拍图的实测分布（见文件头与各条注释）。
    两条经验贯穿始终：
      · 「鲜明橘」决定是否橘系（橘猫/三花），「棕灰」决定是否狸花系；
      · 判定黑白双色时只看黑白两桶，暖色/灰只是**闸门**，不参与成色。
    """
    white, black = r[WHITE], r[BLACK]
    gray = r[GRAY]
    orange, brown = r[ORANGE], r[BROWN]
    warm = orange + brown              # 暖色总量（橘系证据之和）
    dark = black + 0.5 * gray          # 有效暗色（黑毛反光常落灰桶）
    # 有效暗部：黑 + 半数灰 + 暗棕（棚拍/柔光下的黑块是带反光的深棕）
    dark_like = dark + brown_dark
    light = white + 0.5 * gray         # 有效浅色（阴影里的白毛）
    white_like = white + pale          # 白 + 暖白（只给三花判定用，见 warm_white）
    ev = []

    top = bands["上1/3(头/背)"]
    bot = bands["下1/3(腹/爪)"]

    # 规则 0：强奶牛 —— 大块白 + 真黑块，两色都过 0.12。
    # 为什么排在三花之前：三花规则放得很宽（真黑块可能只有 0.3%），
    # 一只「白 0.54 / 黑 0.16」的奶牛猫只要沾到 0.1 的暖色（暖光染色的白毛）
    # 就会被三花抢走（实测 奶牛猫2）。黑白两桶同时过半是双色的铁证。
    # 2026-11-11：白改用 white_like（白 + 暖白）。同窝的另一张实拍
    # （奶牛猫-有人手干扰-裁剪2）里白毛被暖光/脏污染色，纯白桶只有 .264、
    # 暖白 .024，白门槛 0.28 差一点没够到 → 掉进三花；而它的黑是 .239，
    # 四张真三花实拍的黑都 ≤.058 —— 「黑够大」才是双色与三花最干净的分界。
    if white_like >= 0.28 and black >= 0.12:
        ev.append(f"白 {white:.2f}(+暖白 {pale:.2f}) + 黑 {black:.2f} 两色均为大块，"
                  f"斑块度 {patch:.2f}")
        return "cow", "黑白奶牛猫", ev

    # 规则 1：三花 —— 白身 + 鲜明橘斑 + 暗色块，三色共存。
    # 实测（掩膜加权）：三花系列 白 .23~.43 / 鲜明橘 .10~.15 / 暗 .11 上下；
    # 白猫（夜）白只有 .10、橘猫 白 ≤.07 —— 白门槛 .18 正好把它们挡在外面。
    # 真黑块可以很小（幼猫只有耳朵/头顶一小块，black 实测 0.003），
    # 所以这里用 dark（= 黑 + 半数灰，容反光）而不是严格的 black。
    # 2026-11-10 两处放宽，都来自「三花猫.jpg」（手捧幼猫）实测：
    #   · 白用 white_like（白 + 暖白）—— 暖光下白肚皮 S 被染到 60~80，
    #     纯白桶只有 .09，加暖白后 .19；暗块门槛 .08 → .05（幼猫的黑色
    #     斑块小、又被手臂阴影吃掉一半，实测 dark .06）。
    #   · 放宽的前提是**先剔掉人手**（见 drop_border_warm），否则橘毛占比
    #     虚高，任何白门槛都救不回来。
    if white_like >= 0.18 and orange >= 0.10 and dark_like >= 0.05:
        ev.append(f"白 {white:.2f}(+暖白 {pale:.2f}) + 鲜明橘斑 {orange:.2f} "
                  f"+ 暗块 {dark_like:.2f} 三色共存")
        return "calico", "三花猫", ev

    # 规则 2：鲜明橘主导 → 橘猫。
    # 实测橘猫系列「鲜明橘」.85~.99，而狸花/深棕底毛的鲜明橘 ≤.15
    # （它们的暖色证据几乎全在低饱和的「棕灰」桶里）—— 这是橘猫与
    # 狸花最干净的分界线，比「暖色总量」可靠得多（橘猫总暖 .88~.99、
    # 狸花 .78，两者靠总量根本分不开）。
    # 2026-11-10：加两条排除（命中任一就不算「纯橘」）。
    # ① 棕灰底毛 + 暗纹 → 是狸花（棚拍狸花猫1 鲜明橘 .452 刚好压线，
    #    棕灰 .459、暗棕 .256）；
    # ② 几乎无白 + 有暗部 → 是玳瑁（玳瑁猫1/2 鲜明橘 .79~.83 与橘猫
    #    完全重叠，唯一稳定的差别是暗部：玳瑁 .07~.14、橘猫 0）。
    if (orange >= 0.45 and white <= 0.15
            and not (brown >= 0.30 and dark_like >= 0.12)
            and not (white < 0.10 and dark_like >= 0.06)):
        ev.append(f"鲜明橘毛主导（{orange:.2f}），条纹分 {stripe:.2f}")
        return "orange", "橘猫", ev

    # 规则 3：黑白双色调 → 奶牛 / 燕尾服。**排在狸花之前**：
    # 奶牛猫的黑白大斑块边界会带出可观的棕灰（实测奶牛猫 棕灰 .42、
    # 奶牛猫3 .41 —— 暖光下的白毛 + 反光黑毛），先进狸花分支就全错。
    # 暖色闸放到 .55：只挡「橘系」，不挡灯光染色。
    if (white >= 0.12 and black >= 0.05 and light >= 0.15 and dark >= 0.12
            and warm <= 0.55 and gray <= 0.35 and patch >= 0.40):
        ev.append(f"黑白双色（白 {white:.2f} / 黑 {black:.2f}），"
                  f"斑块度 {patch:.2f}，条纹分 {stripe:.2f}（斑块非条纹）")
        # 空间证据：上带黑多 = 头顶/背部黑斑；下带白多 = 白腹白爪
        if top["black"] >= 0.15 and bot["white"] >= 0.30:
            ev.append(f"上 1/3 黑占比 {top['black']:.2f}（头顶/背黑斑），"
                      f"下 1/3 白占比 {bot['white']:.2f}（白腹/白手套）")
        # 白块可观 → 奶牛（黑多白少也是奶牛，民间「奶牛猫」指黑白斑块猫）；
        # 白块很小（白围脖白爪）→ 燕尾服
        if white >= 0.12 or light >= 0.25:
            return "cow", "黑白奶牛猫", ev
        return "tuxedo", "燕尾服猫", ev

    # 规则 4：棕灰底毛 + 暗色 → 狸花。
    # 狸花的物理本质是「暖黄褐/棕灰底毛 + 深色条纹」：底毛落在棕灰桶
    # （S 35~65，实测狸花 .78），条纹是暗色（dark 高）。
    if brown >= 0.30 and dark_like >= 0.12 and gray <= 0.30:
        ev.append(f"棕灰底毛（{brown:.2f}）+ 暗色条纹（dark_like {dark_like:.2f}），"
                  f"条纹分 {stripe:.2f}")
        return "tabby", "狸花猫", ev

    # 规则 4c：玳瑁 —— 橘系主体 + 暗色斑驳、几乎没有白（2026-11-10 新增）。
    # 标准照实测：玳瑁 橘 .79~.83 / 棕灰 .12 / 白 ≤.02 / 暗部（含暗棕）.07~.14；
    # 橘猫 橘 .60~.81 但暗部 ≈0 —— 暗部是玳瑁与橘猫唯一稳定的分界线。
    # 排在狸花之后：狸花2（橘 .40 / 棕灰 .40 / 白 .04）先被狸花规则接走，
    # 不会被这里抢成玳瑁。
    if orange >= 0.30 and white < 0.10 and dark_like >= 0.06:
        ev.append(f"橘毛主体（{orange:.2f}）+ 暗色斑驳（dark_like {dark_like:.2f}）"
                  f"+ 几乎无白（{white:.2f}）—— 玳瑁")
        return "tortoiseshell", "玳瑁猫", ev

    # 规则 4b：夜间/暖光下的浅色猫救援（2026-11-10 实测两张「白猫-黑天」）：
    # 钠灯把白毛整身染成低饱和暖色（棕灰 .28~.43）、亮度落在灰桶，
    # 黑白两桶都不占多数，只剩「灰占 1/3 上下 + 白/黑各一成 + 无鲜明橘」。
    # 真黑猫的 black 会到 .33+（狸花猫2），真灰猫 gray 会到 .40+。
    if (gray >= 0.30 and white < 0.15 and black < 0.20
            and orange < 0.10 and dark < 0.40):
        ev.append(f"白毛被暖光染色（灰 {gray:.2f} + 棕灰 {brown:.2f}），"
                  f"无鲜明橘、无真黑块 —— 判为浅色猫")
        return "white", "纯白猫", ev

    # 规则 5：单色占绝对多数 → 纯色猫
    if light >= 0.55 and warm <= 0.30:
        ev.append(f"浅色占绝对多数（白 {white:.2f} + 亮灰 {gray:.2f}）")
        return "white", "纯白猫", ev
    if dark >= 0.55:
        ev.append(f"暗色占绝对多数（{dark:.2f}）")
        return "black", "纯黑猫", ev
    if gray >= 0.40 and warm <= 0.30:
        ev.append(f"灰色主导（{gray:.2f}）")
        return "gray", "灰猫", ev
    # 暗色为主的深色猫 + 少量棕灰底毛 → 深色狸花（狸花猫2 实测
    # black .33 / gray .39 / 棕灰 .08，底色被阴影压到黑灰桶）
    if dark >= 0.30 and brown >= 0.05 and stripe >= 0.80:
        ev.append(f"深色底毛（dark {dark:.2f}）+ 条纹（{stripe:.2f}）")
        return "tabby", "狸花猫", ev

    return "", "无法判断（颜色不集中）", [f"白 {white:.2f} / 黑 {black:.2f} / "
                                          f"灰 {gray:.2f} / 橘 {orange:.2f} / 棕 {brown:.2f}"]


# ------------------------------------------------------------- 第 4 步：三特征
def coat_color(r: Dict[int, float], value: str) -> Tuple[str, str, List[str]]:
    """毛色：从调色板挑出占比 ≥0.12 的毛色，组成「黑白双色 / 三色 / 纯橘」式描述。

    毛色回答「这只猫身上有哪些颜色」——它只看色桶占比，与花纹无关：
    一只带虎斑纹的橘猫和一只纯橘猫的毛色都是「橘」。

    需要品种上下文（value 参数）修正两种灯光假象（均来自 19 张标定图实测）：
      · 夜间/暖光白猫：白毛被钠灯染成灰棕，统计上白桶 <0.15、灰棕占大头
        —— 品种判定为白猫时，毛色必须回到「白」，把染色写进注释；
      · 奶牛/燕尾服：白毛在暖光下泛棕（棕桶可达 0.4），黑白都在时
        毛色定性为黑白双色，棕调作为染色注释。
    返回 (枚举值, 中文描述, 证据)。"""
    names = {WHITE: "白", BLACK: "黑", GRAY: "灰", ORANGE: "橘", BROWN: "棕"}
    parts = [(names[b], r[b]) for b in (WHITE, BLACK, ORANGE, BROWN, GRAY)
             if r[b] >= 0.12]
    parts.sort(key=lambda x: -x[1])
    ev = [f"毛色构成（占比≥12% 的色桶）：{'、'.join(f'{n} {s:.0%}' for n, s in parts)}"
          if parts else "所有色桶占比都低于 12%，无法给出毛色"]
    if not parts:
        return "unknown", "无法判断", ev

    # 上下文修正 ①：低光白猫 —— 白毛被染色不代表毛色不是白
    if value == "white":
        if r[WHITE] >= 0.30:
            return "solid_白", "白色", ev
        ev.append("低光/暖光下白毛被灯光染色，统计上呈灰棕（见品种判定的救援规则）")
        return "solid_白", "白色（低光下略带灰棕调）", ev

    # 上下文修正 ②：黑白双色猫的棕调 = 暖光染色
    if value in ("cow", "tuxedo") and r[BLACK] >= 0.08 and r[WHITE] >= 0.08:
        if r[BROWN] >= 0.12:
            ev.append(f"棕调 {r[BROWN]:.0%} 为暖光下的毛色染色（白毛/黑毛反光），不计入毛色定性")
        return "bi_黑_白", "黑白双色", ev

    cs = [n for n, _ in parts]
    if len(parts) == 1:
        v, desc = f"solid_{cs[0]}", f"纯{cs[0]}色"
    elif len(parts) == 2:
        v, desc = f"bi_{cs[0]}_{cs[1]}", f"{cs[0]}{cs[1]}双色"
    elif {"白", "黑"} <= set(cs) and ("橘" in cs or "棕" in cs):
        v, desc = "tri", f"三色（{'、'.join(cs)}）"
    else:
        v, desc = "multi", f"多色（{'、'.join(cs)}）"
    return v, desc, ev


def markings(value: str, patch: float, stripe: float,
             bands: Dict[str, Dict[str, float]]) -> Tuple[str, str, List[str]]:
    """花纹：色块的几何形态 —— 条纹（虎斑）/ 斑块 / 纯色。

    ⚠️ 诚实的工程取舍：独立的花纹几何度量在这批实拍数据上全部被毛流
    阴影污染（瓦片纯净度、暗色连通域、FFT 频谱、纹理梯度都试过，
    橘猫毛的反光纹理能伪装出条纹/多组件的所有特征），所以花纹与
    品种判定**共享同一套已验证的证据链**（色桶结构 + 斑块度 + 分带
    空间证据），而不是拿一个不可靠的独立指标硬凑。
    返回 (枚举值, 中文名, 证据)。"""
    ev = [f"几何证据：斑块度 {patch:.2f}，条纹分 {stripe:.2f}（与品种判定同源）"]
    top = bands["上1/3(头/背)"]
    bot = bands["下1/3(腹/爪)"]
    if value in ("calico", "cow", "tuxedo"):
        spatial = []
        if top["black"] >= 0.15:
            spatial.append(f"上 1/3 深色 {top['black']:.0%}（头/背色斑）")
        if bot["white"] >= 0.30:
            spatial.append(f"下 1/3 白毛 {bot['white']:.0%}（白腹/白手套）")
        if spatial:
            ev.append("空间分布：" + "，".join(spatial))
        if value == "calico":
            return "patch_tri", "三色斑块（色斑边界清晰）", ev
        if value == "cow":
            return "patch_bi", "大块双色斑块", ev
        return "patch_small", "局部白斑（燕尾服式）", ev
    if value == "tabby":
        return "striped", "条纹（虎斑纹）", ev
    if value in ("orange", "white", "black", "gray"):
        return "solid", "纯色（无明显花纹）", ev
    return "unclear", "不明确（颜色不集中，花纹无从谈起）", ev


def breed_of(value: str, label: str) -> Tuple[str, List[str]]:
    """品种：外貌花色归类（民间俗称），不是血统鉴定。

    靠颜色和花纹判断不了英短/布偶/暹罗 —— 硬猜就是误导。 campus
    流浪猫几乎都是中华田园猫，所以品种给「中华田园猫 + 花色俗称」，
    俗称与 decide() 的结论同源。"""
    if not value:
        return "无法判断", ["颜色证据不足，无法归类"]
    return f"中华田园猫（{label}）", [
        f"按外貌花色归类为「{label}」—— 中华田园猫的常见花色型；"
        "血统品种无法从单张照片判定"]


# ------------------------------------------------------------- 可用性门控
def _mask_small(mask, size: int = SIZE):
    """把外部传入的掩膜统一成 size×size 的 0~1 浮点权重；坏掩膜返回 None。"""
    if mask is None:
        return None
    try:
        m = np.asarray(mask, dtype=np.float32)
    except Exception:   # noqa: BLE001
        return None
    if m.ndim != 2 or m.size == 0:
        return None
    m = np.clip(m, 0.0, 1.0)
    if m.shape != (size, size):
        m = np.asarray(Image.fromarray((m * 255).astype(np.uint8))
                       .resize((size, size), Image.BILINEAR), dtype=np.float32) / 255.0
    return m.astype(np.float64)


def sharpness(rgb: Image.Image, fg: np.ndarray, size: int = 512) -> Optional[float]:
    """前景区域的清晰度（Laplacian 方差，512 长边口径）。

    为什么只在**前景**上算：背景里的瓷砖缝、树叶、栏杆本身就是高频纹理，
    整图方差会把一张糊猫照算成「清晰」。没有前景像素时返回 None（放弃门控）。
    纯色块（方差≈0）会被判成糊片 —— 真人拍的照片不可能全无纹理（噪声/jpg
    块效应至少几个方差），而合成图/大面积纯色背景确实不该硬判花色。
    """
    w, h = rgb.size
    s = float(size) / max(1, max(w, h))
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    g = np.asarray(rgb.convert("L").resize((nw, nh), Image.BILINEAR), dtype=np.float32)
    m = np.asarray(Image.fromarray((fg.astype(np.float32) * 255).astype(np.uint8))
                   .resize((nw, nh), Image.NEAREST)) > 127
    if int(m.sum()) < 500:
        return None
    lap = np.zeros_like(g)
    lap[1:-1, 1:-1] = (4.0 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1]
                       - g[1:-1, :-2] - g[1:-1, 2:])
    return float(lap[m].var())


def quality_gate(rgb: Image.Image, mask,
                 params: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """先问「这张照片能不能判断花色」，再问「是什么花色」。

    对应 app/attrs.py 的 L0 门控（同一套阈值，默认 10 与 0.005）：
    糊片 / 画面里几乎没有猫体时拒绝下结论，把**重拍提示**交给
    `analyze()` 的 reason —— 这正是用户要的「不好识别就说识别不了」。
    mask 为 None（没抠图）时放行：没有前景就没法把「猫糊」和「背景糊」分开。
    """
    p = dict(DEFAULTS)
    p.update(params or {})
    m = _mask_small(mask)
    if m is None:
        return {"ok": True, "sharp": None, "fg": None}
    fg = m >= 0.5
    cov = float(fg.mean())
    if cov < float(p["min_fg"]):
        return {"ok": False, "fg": round(cov, 4), "sharp": None,
                "reason": "画面里几乎找不到猫体（有效占比 %d%%），可能被遮挡、糊掉或太暗。"
                          "请把猫完整拍进画面后重试。" % int(round(100 * cov))}
    sh = sharpness(rgb, fg, int(p["sharp_size"]))
    if sh is not None and sh < float(p["min_sharp"]):
        return {"ok": False, "fg": round(cov, 4), "sharp": round(sh, 1),
                "reason": "照片偏模糊（清晰度 %d，需要 %d 以上），花色会判不准。"
                          "请对焦后重拍一张清晰的照片。" % (int(sh), int(p["min_sharp"]))}
    return {"ok": True, "fg": round(cov, 4),
            "sharp": None if sh is None else round(sh, 1)}


# ------------------------------------------------------------- 主流程
def _pipeline(crop: Image.Image, mask, located: bool,
              params: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """在一张「已经定位好的猫体图」上跑完色板 → 布局 → 判定，返回完整结果。

    mask 可以是 None（没抠图 → crop 已紧贴猫体，全权重）或与 crop 同尺寸/
    任意尺寸的软掩膜（会统一缩到 SIZE×SIZE）。
    """
    small = crop.resize((SIZE, SIZE), Image.BILINEAR)
    m = _mask_small(mask)
    if m is not None:
        weight = m
    elif located:
        weight = np.ones((SIZE, SIZE), dtype=np.float64)   # crop 已紧贴猫体
    else:
        weight = center_weight()                            # 整图兜底

    idx = classify_buckets(small, weight)

    # 第 1.5 步：剔除从 crop 边缘伸进来的连通暖色块（人手/衣袖）
    idx, removed = drop_border_warm(idx, small, params)
    drop = idx == OTHER if removed > 0 else None
    if drop is not None:
        # 被剔除的干扰物要**同时从分母里去掉**：只把像素改成 other 而保留
        # 权重，等于让手占据 30%~50% 的比例、把真猫毛的占比整体压低
        # （实测 奶牛猫-有人手干扰 other 涨到 0.53，黑白占比被挤到门槛以下）。
        # 但如果剔除后一个有效像素都不剩（整框被判成手），保留原权重 ——
        # 宁可保留干扰物，也不能让分母归零（加权占比会除 0）。
        remain = weight * (~drop)
        if float(remain.sum()) > 0:
            weight = remain

    ratio = weighted_ratio(idx, weight)
    bands = band_report(idx, weight)
    patch = patchiness(idx, weight)
    stripe = stripe_score(small, drop)
    pale = warm_white(small, weight)
    bd = brown_dark(small, idx, weight)

    value, label, evidence = decide(ratio, bands, patch, stripe, pale, bd)

    # 第 4 步：品种 / 毛色 / 花纹 三特征
    breed, breed_ev = breed_of(value, label)
    coat_value, coat_desc, coat_ev = coat_color(ratio, value)
    mark_value, mark_desc, mark_ev = markings(value, patch, stripe, bands)

    return {
        "located": located,
        "palette": {BUCKET_NAMES[i]: round(ratio[i], 3) for i in range(len(BUCKET_NAMES))},
        "bands": {k: {c: round(v, 2) for c, v in d.items()} for k, d in bands.items()},
        "patchiness": round(patch, 3),
        "stripe": round(stripe, 3),
        "warm_white": round(pale, 3),
        "brown_dark": round(bd, 3),
        "interference_removed": round(removed, 3),
        "pattern": value or "unknown",
        # 三特征：品种 / 毛色 / 花纹
        "breed": breed,
        "coat": {"value": coat_value, "desc": coat_desc},
        "markings": {"value": mark_value, "desc": mark_desc},
        "evidence": evidence + breed_ev + coat_ev + mark_ev,
        # 内部字段（下划线前缀）：analyze() 换算成 attrs 契约时要用
        "_ratio": ratio,
        "_label": label,
    }


def recognize(path: str,
              params: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """独立入口（CLI / 回归测试）：从磁盘读图 → 定位 → 抠图 → 判定。"""
    im = Image.open(path).convert("RGB")

    # 第 0 步：YOLO 定位猫体，裁出主体；失败退回整图 + 中心加权
    box, conf, reason = locate_cat(im)
    if box is not None:
        crop = im.crop(tuple(box))
        located = True
    else:
        crop = im
        located = False

    # 第 0.5 步：抠图，把统计限制在猫毛像素上（背景/地面/人手不进调色板）
    mask = foreground_mask(crop)
    q = quality_gate(crop, mask, params)
    out = _pipeline(crop, mask, located, params)
    out.update({
        "image": path,
        "detect_conf": round(conf, 3),
        "detect_reason": reason,
        "box": box,
        "quality": q,
    })
    return out


# ------------------------------------------------------------- attrs 契约入口
# 花纹枚举 → app/attrs.py 的纹理取值（PATTERN_LABELS 的 key）
_TEXTURE = {"striped": "tabby", "solid": "solid", "patch_bi": "cow",
            "patch_tri": "calico", "patch_small": "cow", "unclear": ""}

_PALETTE_KEYS = ("white", "black", "gray", "orange", "brown")


def confidence_of(ratio: Dict[int, float]) -> float:
    """置信度 = 「最大色占比有多集中」，与 attrs._confidence_of 同一条曲线。

    只反映调色板的集中度，不反映结论的正确性（糊帧也可能很集中）——
    所以它只用于展示分级，不参与任何阈值判定。"""
    top = max(float(ratio[i]) for i in range(WHITE, OTHER))
    return round(min(0.88, 0.45 + 0.40 * min(1.0, top / 0.55)), 3)


def analyze(im: Image.Image, cropped: bool = False, mask=None,
            params: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """attrs 契约入口 —— `app/attrs.py` 里 `ATTR_ENGINE=pattern` 走这里。

    输入与 `attrs.analyze()` 完全一致，因此引擎那侧不用改调用方式：
      im       : 已经裁到猫体的图（cropped=True）或整图
      cropped  : im 是不是「紧贴猫体」的 crop
      mask     : 与 im 同坐标的前景软掩膜（0~1）；没有就 None
      params   : 覆盖 DEFAULTS 的门控阈值（app 侧传自己的 config，保持同一把尺子）

    输出字段与 `attrs.analyze()` 逐项对齐（color / pattern / breed /
    confidence / source / palette / stripe / shift / reason / refused），
    上层（engine → main → search）不需要知道底下换了一套算法。
    另外多一个 `engine="pattern"` 便于排查与 A/B。
    """
    q = quality_gate(im, mask, params)
    base: Dict[str, Any] = {"source": "heuristic", "engine": "pattern",
                            "shift": 0.0, "quality": q}
    if not q["ok"]:
        return dict(base, color="", pattern="", breed="", confidence=0.0,
                    palette=[], stripe=0.0, reason=q["reason"], refused=True)

    out = _pipeline(im, mask, bool(cropped), params)
    ratio = out["_ratio"]
    label = out["_label"]
    top = max(float(ratio[i]) for i in range(WHITE, OTHER))
    # 判不出来时 color 必须是**空串**（attrs 契约）：decide() 的 unknown 只表示
    # 「没结论」，写成 "unknown" 会被 engine 当成有效花色（attr 前端枚举里也没有
    # 这个值），既挡住低置信 CLIP 兜底，又可能被写进档案。
    # ⚠️ 不能用 `if not label` 判断：unknown 时 decide() 返回的是「无法判断（…）」
    # 这段文案，label 永远非空，那个分支以前是死代码。
    if out["pattern"] in ("", "unknown"):
        return dict(base, color="", pattern="", breed="", confidence=0.0,
                    palette=[], stripe=out["stripe"], refused=False,
                    reason="颜色不集中（最大色占比 %d%%），无法判断花色"
                           % int(round(100 * top)))

    palette = [
        {"key": _PALETTE_KEYS[i], "label": BUCKET_NAMES[i], "ratio": round(ratio[i], 3)}
        for i in sorted(range(WHITE, OTHER), key=lambda k: -ratio[k])[:3]
        if ratio[i] >= 0.05
    ]
    return dict(base,
                color=out["pattern"],
                pattern=_TEXTURE.get(out["markings"]["value"], ""),
                breed=label,
                confidence=confidence_of(ratio),
                palette=palette,
                stripe=out["stripe"],
                reason="",
                refused=False,
                # 诊断用：干扰物剔除比例 / 暖白占比，排查「为什么它判成三花」看这两个
                interferenceRemoved=out["interference_removed"],
                warmWhite=out["warm_white"])


def main() -> int:
    ap = argparse.ArgumentParser(description="看图说话式猫花色识别")
    ap.add_argument("image", help="图片路径")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    reconf = getattr(sys.stdout, "reconfigure", None)   # Windows GBK 控制台兜底
    if callable(reconf):
        reconf(encoding="utf-8", errors="replace")
    if not Path(args.image).is_file():
        print(f"图片不存在：{args.image}", file=sys.stderr)
        return 2

    result = recognize(args.image)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"图片：{result['image']}")
        print(f"定位：{'成功' if result['located'] else '失败（整图分析）'} "
              f"conf={result['detect_conf']} box={result['box']} {result['detect_reason']}")
        print(f"调色板：{result['palette']}")
        for band, d in result["bands"].items():
            print(f"  {band}: 黑 {d['black']:.2f} / 白 {d['white']:.2f}")
        print(f"斑块度：{result['patchiness']}   条纹分：{result['stripe']}")
        print(f"品种：{result['breed']}")
        print(f"毛色：{result['coat']['desc']}")
        print(f"花纹：{result['markings']['desc']}")
        for e in result["evidence"]:
            print(f"  - {e}")
    return 0 if result["pattern"] != "unknown" else 1


if __name__ == "__main__":
    sys.exit(main())
