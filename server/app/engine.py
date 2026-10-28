"""
推理引擎：猫体检测 + 个体特征提取 + 毛色分类。

三级降级策略（任何一级不可用都不影响服务启动）：
  1. ONNX Runtime —— 推荐，镜像小、CPU/GPU 都快，需要先用 tools/export_onnx.py 导出权重
  2. PyTorch + timm —— 开发调试方便，首次运行会联网拉权重
  3. 内置哈希引擎 —— 占位，保证链路可跑通但结果是演示级

关键认知：这里的「特征提取」不需要你训练任何东西。
MegaDescriptor / DINOv2 这类骨干已经在海量数据上学好了「把图片变成有区分度的向量」，
我们要做的只是把照片喂进去、把向量存起来 —— 这就是所谓的「建特征库」。
"""
from __future__ import annotations

import hashlib
import logging
import math
import os
import time
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

from . import config
from . import attrs as attr_heuristic

log = logging.getLogger("catcampus.engine")

_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _dim_of(shape) -> Optional[int]:
    """从 ONNX 输出的动态 shape 里取出最后一维（如 [1, 'tokens', 768] → 768）。"""
    for v in reversed(list(shape)):
        if isinstance(v, int):
            return v
    return None


def _pool(outs: list) -> np.ndarray:
    """把骨干网络的多形态输出统一压成一条句向量。

    不同导出方式的输出形状差别很大，不处理会得到几十万维的垃圾向量：
      - 池化版  : [1, D]              → 直接展平
      - token 版: [1, N, D]           → 取 CLS token（见下）
    DINOv2 输出的是后者（[1, 257, 768]，含 CLS token），必须池化。

    ⚠️ 只认 **batch=1** 的 token 张量。早期写法对 [B, N, D]（B>1）会取
    `a[0][0]` —— 把 batch 里第一只猫的 CLS 当成整批的代表，静默出错不报异常。
    宁可直接抛错，也不要悄悄产出错误向量（调用方 media.fetch_image 会
    try/except 掉并跳过该项，不会 500）。
    """
    arrs = [np.asarray(o, dtype=np.float32) for o in outs if getattr(o, "size", 1) > 0]
    if not arrs:
        raise RuntimeError("骨干网络无输出")

    for a in arrs:
        if a.ndim == 2:
            return a.reshape(-1)
    for a in arrs:
        if a.ndim == 3:
            if a.shape[0] != 1:
                raise RuntimeError(
                    f"token 版输出只支持 batch=1 池化（实际 shape={list(a.shape)}）")
            # CLS token（第 0 个）——DINOv2 官方推荐的检索用法。
            # 实测依据（scripts/probe_pool_preprocess.py，3 张不同颜色猫照）：
            # 全 token 平均会把不同猫推到余弦 0.88~0.95（线上出现过两只不同色的猫
            # 0.953 / 展示分 97% 的贴脸误匹配），CLS 把类间压到 ~0.74，
            # 类内-类间间隔扩大约 3 倍。**改这里必须递增 config.FEATURE_POOL_VERSION
            # 并重建特征库**（新旧向量同维不同义，混算会乱匹配）。
            # ⚠️ a 是 [1, tokens, dim]：先剥 batch（a[0]）再取第 0 个 token ——
            # 漏剥一层会把整块 257×768 摊平成 197376 维（实测踩过）。
            return np.asarray(a[0][0], dtype=np.float32).reshape(-1)
    return arrs[0].reshape(-1)


def _probe_batch1(sess, input_name, size: int) -> bool:
    """验证模型确实接受 batch=1 的 [1,3,size,size] 输入（启动时跑一次全零张量）。

    为什么必须真跑：ONNX 的输入 shape 里 batch 维常常标成 -1（动态），
    而模型内部可能有固定 batch 的算子。不验证的话首张图片进来才炸。
    """
    try:
        sess.run(None, {input_name: np.zeros((1, 3, size, size), dtype=np.float32)})
        return True
    except Exception as e:  # noqa: BLE001
        log.error("输入校验失败（batch=1, %dx%d）：%s", size, size, e)
        return False


def l2(v: np.ndarray) -> np.ndarray:
    """L2 归一化，之后余弦相似度 == 点积，检索可以直接用矩阵乘。
    NaN 必须显式拦截：np.linalg.norm(含NaN向量)=NaN，而 NaN 是 truthy，
    `v / n if n else v` 会放行并产出全 NaN 向量，一路带崩下游 stack/argsort。
    模型数值不稳时给零向量（相似度全 0），不扩散也不崩。"""
    n = np.linalg.norm(v)
    if not np.isfinite(n):
        return np.zeros_like(v)
    return v / n if n else v


def rep_vector(embs: List[np.ndarray], keep: float = 0.0,
               spread_min: Optional[float] = None) -> np.ndarray:
    """把同一个体的多条向量合成一条**代表向量**：medoid + 内点平均。

    为什么不直接平均：平均值对离群点没有抵抗力。档案里 5 张照片、其中 1 张
    是「糊了」/「拍的是旁边的另一只猫」/「猫只占角落一成」，平均出来的向量
    会被拽向那个离群点，而检索时它是这只猫唯一的门面 —— 一次错误档案
    会持续污染这只猫的识别，直到有人重拍。
    同一只猫的多数照片彼此高度相似，所以「离群」在向量空间里是**可测的**：
      ① 算两两余弦，取「到其它向量平均相似度最高」的那条当 medoid（中位数样本）；
      ② 只保留离 medoid 最近的 ceil(n*keep) 条求平均。
    keep=0 取 config.REP_KEEP；keep>=1 等价于全部平均（用于不在乎离群的场合）。

    ⚠️ 视图散得开时不要平均（2026-10-25 实测，见 tools/mv_eval.py）：
    档案照是「大头特写 + 远景全身 + 侧身」这种彼此余弦只有 0.80 的组合时，
    平均出来的「中间脸」谁都不像 —— 实测 margin +0.142，而只用 medoid 是
    +0.148。所以先算整体离散度 spread，低于 config.REP_SPREAD_MIN 就退回
    medoid 本身。反过来，档案照彼此很像（spread 0.93）时平均是**降噪**，
    比 medoid 更好（+0.189 vs +0.179）—— 两头都要，所以是自适应而不是一刀切。
    只在 keep<=0（走默认策略）时生效；显式传 keep 表示调用方要指定行为。

    退化处理：n<=2 时不做筛选（两条里分不出谁是离群点，删谁都可能删掉正脸）；
    n==1 直接返回。返回已 L2 归一化。
    """
    vecs = [np.asarray(v, dtype=np.float32).reshape(-1) for v in embs
            if v is not None and np.asarray(v).size]
    if not vecs:
        raise RuntimeError("rep_vector 收到空向量列表")
    if len(vecs) == 1:
        return l2(vecs[0])
    k = float(config.REP_KEEP if keep <= 0 else keep)
    n = len(vecs)
    if k >= 1.0 or n <= 2:
        return l2(np.mean(np.stack(vecs), axis=0))

    mat = np.stack([l2(v) for v in vecs])       # 已归一化，点积即余弦
    sim = mat @ mat.T
    self_sim = sim.copy()
    np.fill_diagonal(self_sim, 0.0)             # 选 medoid 时不能把自己算成「最像」
    medoid = int(np.argmax(self_sim.sum(axis=1)))

    if keep <= 0:
        sm = float(config.REP_SPREAD_MIN if spread_min is None else spread_min)
        # 除掉对角线（n 个 1.0）后取平均，即「两两余弦均值」
        spread = float((sim.sum() - n) / (n * (n - 1)))
        if spread < sm:
            return l2(mat[medoid])

    # 排序用的距离：medoid 与自己的相似度必须是 1（填 0 会让它自己排到最后，
    # 于是「离 medoid 最近的 k 条」把这个 medoid 本身排除掉 —— 实测就是这里错的）
    dist = sim[medoid].copy()
    dist[medoid] = 1.0
    order = np.argsort(-dist)
    keep_n = max(2, min(n, int(math.ceil(n * k))))
    picked = order[:keep_n]
    return l2(np.mean(mat[picked], axis=0))


def _letterbox(im: Image.Image, size: int) -> Image.Image:
    """保持长宽比缩放并补灰边，避免直接 resize 拉伸导致个体形变。

    ⚠️ 缩放系数一律按**传进来的这张图自己**的尺寸算（`max(w, h)`）。
    早期写法算的却是外部原图的尺寸，然后拿这个系数去缩一张形状不同的 crop ——
    crop 被检测框裁得越扁/越窄，偏差越大，极端时缩放后一边远超 size，
    ONNX 报 "Attempting to broadcast an axis by a dimension other than 1. 257 by 1370"。
    """
    w, h = im.size
    s = size / max(w, h)
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    # 双保险：无论上面算式怎样，绝不让贴图超出画布（paste 越界会静默裁掉，
    # 反而掩盖了尺寸算错）
    nw, nh = min(size, nw), min(size, nh)
    im2 = im.resize((nw, nh), Image.BICUBIC)
    canvas = Image.new("RGB", (size, size), (128, 128, 128))
    canvas.paste(im2, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def _resolve_detect_model() -> str:
    """决定用哪个检测模型，返回路径；空串表示不检测。

    规则（按优先级）：
      1. `DETECT_ONNX=off / none / 0 / false` —— 显式关闭，即使模型文件在旁边也不用。
      2. `DETECT_ONNX` 指向具体文件 —— 用它（配错路径会在 _Detector 里告警并降级）。
      3. `DETECT_ONNX` 为空且 `DETECT_AUTO` 开着 —— 自动发现 `models/yolov8n.onnx`。

    为什么要自动发现：模型随仓库走（12.8MB），部署时漏配环境变量是最常见的
    「代码明明改了、线上没生效」。自动发现让「把 server/ 放上去」就等于启用，
    而想关的人有明确的开关可拨（第 1 条），不存在「关不掉」的问题。
    """
    raw = (config.DETECT_ONNX or "").strip()
    if raw.lower() in ("0", "off", "none", "false", "no"):
        return ""
    if raw:
        return raw
    if not config.DETECT_AUTO:
        return ""
    cand = os.path.join(_SERVER_DIR, "models", "yolov8n.onnx")
    return cand if os.path.exists(cand) else ""


def _iou(a: List[int], b: List[int]) -> float:
    """两个 xyxy 框的交并比。"""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = float(iw * ih)
    if inter <= 0:
        return 0.0
    area_a = float((a[2] - a[0]) * (a[3] - a[1]))
    area_b = float((b[2] - b[0]) * (b[3] - b[1]))
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _pick_subject(boxes: List[List[int]], confs: List[float],
                  iou_thr: float = 0.45) -> int:
    """从候选框里挑出「画面主体」，返回下标；空列表返回 -1。

    两步，缺一不可：
      ① **NMS 去重**。YOLO 导出的是未做后处理的原始输出，同一只猫会给出十几条
         高度重叠的框（实测一张图 10 条）。不去重的话「面积最大」很容易被同一只猫
         的另一个框命中，等于白算。
      ② **按面积而非置信度选**。用户拍的是「这只猫」，画面主体就是面积最大的那只；
         置信度最高的往往是构图里最近、最清楚的那只小猫，未必是主体。
         这与 `_Detector.__call__` 文档里承诺的「面积最大的猫框」也一致。
    """
    if not boxes:
        return -1
    order = sorted(range(len(boxes)), key=lambda i: -confs[i])
    kept: List[int] = []
    for i in order:
        if all(_iou(boxes[i], boxes[j]) <= iou_thr for j in kept):
            kept.append(i)
    if not kept:
        return -1
    return max(kept, key=lambda i: (boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]))


def _pad_box(box: List[int], w: int, h: int, ratio: float) -> List[int]:
    """把框按比例外扩并夹到画面内。

    检测框天生「贴得紧」：猫耳尖、尾巴、后腿常被切在框外。少一点边缘会让
    个体特征更完整（尤其是靠尾巴/耳形区分的猫）。外扩比例不能大 ——
    每扩 10% 就多带进一圈背景，而背景正是检测要消掉的东西。默认 8%。
    """
    if not box or ratio <= 0:
        return box
    bw, bh = box[2] - box[0], box[3] - box[1]
    dx, dy = int(round(bw * ratio)), int(round(bh * ratio))
    return [max(0, box[0] - dx), max(0, box[1] - dy),
            min(w, box[2] + dx), min(h, box[3] + dy)]


_AUTO_BOX = object()   # 哨兵：box=_AUTO_BOX 表示「没给框，自己检测」


def _run_detect(detector, im: Image.Image) -> Dict:
    """调检测器并统一成 dict 返回。

    兼容只有 `__call__` 的检测器实现（测试替身、以及早期只返回框的接口）：
    没有 `detect()` 就用 `__call__` 拿框，置信度未知按 0 报。
    """
    fn = getattr(detector, "detect", None)
    if callable(fn):
        return fn(im)
    box = detector(im)
    return {"box": box, "core": box, "conf": 0.0, "candidates": 1 if box else 0,
            "reason": "" if box else "未检测到猫体"}


def _detect_box_to_xyxy(box, w: int, h: int, size: int) -> List[int]:
    """把检测模型输出的一个框还原成**原图坐标**的 [x1, y1, x2, y2]。

    两个坑都在这里，且都会静默给出一个「看起来很正经」的错误框：

    ① 输出格式是 **cxcywh**，不是 xyxy。YOLOv5/v8/v11 直接导出的 ONNX 都是
       `[1, anchors, 4+nc]`，前 4 列是中心点 + 宽高。早期这里按「像素则当 xyxy」
       处理，于是把 `(cx=283, cy=330, bw=363, bh=390)` 读成右下角 (363, 390)，
       裁出来是一块 80×60 的胸口碎毛 —— 提特征时等于随机采样一块背景。
    ② 逆变换必须按 **letterbox** 算。`_to_nchw` 是「按长边缩放 + 居中补边」，
       缩放系数是 `size/max(w, h)` 且带 padding；早期用 `w/size, h/size`，
       那是「拉伸成正方形」的系数，任何非方图都会错位，越扁错得越多。

    归一化坐标（0~1）的导出也存在，用 1.5 做分界：一个框不可能只有 1.5 像素。
    """
    cx, cy, bw, bh = (float(v) for v in box[:4])
    if max(cx, cy, bw, bh) <= 1.5:
        cx, cy, bw, bh = cx * size, cy * size, bw * size, bh * size

    s = size / max(w, h)
    pad_x, pad_y = (size - w * s) / 2.0, (size - h * s) / 2.0
    x1, y1 = (cx - bw / 2 - pad_x) / s, (cy - bh / 2 - pad_y) / s
    x2, y2 = (cx + bw / 2 - pad_x) / s, (cy + bh / 2 - pad_y) / s

    # 夹到画面内：检测框可以越界（模型偶尔给负数），crop 越界会被 PIL 静默补黑边
    x1, x2 = max(0, min(w, x1)), max(0, min(w, x2))
    y1, y2 = max(0, min(h, y1)), max(0, min(h, y2))
    box_out = [int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2))]
    # 退化框（宽或高为 0）一律当检测失败，否则 crop 出 0 像素图会让 embedding 崩
    if box_out[2] - box_out[0] < 8 or box_out[3] - box_out[1] < 8:
        return []
    return box_out


def _probe_input_size(sess, input_name, prefer=None):
    """推断并**验证**骨干网络真正能接受的输入边长。

    ⚠️ ViT 类骨干对输入边长是硬的：token 数 = (边长 / patch)^2 + 1。尺寸不对会在
    patch embedding 加 position embedding 那一步报广播错误（形如 "257 by 1370"），
    表现就是 /v1/index/build 500 Internal Server Error。

    线上踩过：REID_SIZE 默认 518（DINOv2 常用值），但打进镜像的 reid.onnx 是在 224
    上导出的；本地 .env 里恰好手写了 224，把这个差异完全掩盖，直到上云后第一次真实
    推理才炸。所以这里不能只是「读配置」，必须**用一张全零图真跑一次确认** ——
    宁可启动时多花百来毫秒，也不要等到识别时才崩。
    """
    tokens = 0
    try:
        shape = list(sess.get_outputs()[0].shape)
        # DINOv2/ViT 输出形如 ['batch_size', 257, 768]，第二维是 token 数
        if len(shape) == 3 and isinstance(shape[1], int):
            tokens = int(shape[1])
    except Exception:  # noqa: BLE001
        tokens = 0

    order = []
    if prefer:
        order.append(int(prefer))
    n = tokens - 1
    if n > 0:
        root = int(round(n ** 0.5))
        for patch in (14, 16, 32):
            order.append(root * patch)
    order += [224, 256, 384, 518]

    tried = []
    for size in order:
        if not size or size in tried:
            continue
        tried.append(size)
        try:
            sess.run(None, {input_name: np.zeros((1, 3, size, size), dtype=np.float32)})
            if prefer and size != int(prefer):
                log.warning(
                    "REID_SIZE=%s 与该模型不匹配（模型 token 数=%s），自动改用 %d",
                    prefer, tokens or "?", size,
                )
            return size
        except Exception:  # noqa: BLE001
            continue

    log.error("未能确定可用输入边长（已试：%s），回退 %s", tried, prefer or 224)
    return int(prefer or 224)


def _to_nchw(im: Image.Image, size: int, mean, std) -> np.ndarray:
    im2 = _letterbox(im.convert("RGB"), size)
    a = np.asarray(im2, dtype=np.float32) / 255.0
    a = (a - np.array(mean, dtype=np.float32)) / np.array(std, dtype=np.float32)
    x = np.transpose(a, (2, 0, 1))[None, ...]
    # 出口自检：_letterbox 保证短边 ≤ size，一旦这里不成立说明缩放被绕过/算错，
    # 早失败并说清原因，而不是让 ONNX 抛一句难懂的广播错误（见 _probe_batch1 注释）。
    if tuple(x.shape) != (1, 3, int(size), int(size)):
        raise RuntimeError(
            f"模型输入尺寸不对：期望 (1,3,{int(size)},{int(size)})，实际 {tuple(x.shape)}"
            f"（原图 {im.size}）")
    return x


class _Embedder:
    """把一张猫图变成一条归一化的特征向量。"""

    def __init__(self):
        self.backend = "hash"
        self.dim = 128
        self.size = int(config.REID_SIZE)   # 实际输入边长（ONNX 分支会按模型校准）
        self._load()

    # ---------- 加载 ----------
    def _load(self):
        if config.REID_ONNX:
            try:
                import onnxruntime as ort  # type: ignore

                providers = ["CPUExecutionProvider"]
                if config.DEVICE in ("auto", "cuda"):
                    if "CUDAExecutionProvider" in ort.get_available_providers():
                        providers.insert(0, "CUDAExecutionProvider")
                self.sess = ort.InferenceSession(config.REID_ONNX, providers=providers)
                self.input_name = self.sess.get_inputs()[0].name
                outs = self.sess.get_outputs()
                self.dim = _dim_of(outs[0].shape)
                # 输入边长由「模型说了算」并跑一次空推理确认，不盲信配置
                self.size = _probe_input_size(self.sess, self.input_name, config.REID_SIZE)
                self.backend = "onnx"
                log.info("ReID 引擎就绪：ONNX (%s) dim=%s size=%d",
                         providers[0], self.dim, self.size)
                return
            except Exception as e:  # noqa: BLE001
                log.warning("ONNX 加载失败，回退 PyTorch：%s", e)

        try:
            import torch  # type: ignore
            import timm  # type: ignore

            # num_classes=0 表示只要骨干输出的 embedding，不要分类头
            self.model = timm.create_model(config.REID_TORCH, pretrained=True, num_classes=0)
            self.model.eval()
            dev = "cuda" if (config.DEVICE in ("auto", "cuda") and torch.cuda.is_available()) else "cpu"
            self.torch = torch
            self.dev = torch.device(dev)
            self.model.to(self.dev)
            self.dim = getattr(self.model, "num_features", 1024)
            self.backend = "torch"
            log.info("ReID 引擎就绪：torch %s dim=%d", dev, self.dim)
            return
        except Exception as e:  # noqa: BLE001
            log.warning("PyTorch 不可用，使用占位引擎：%s", e)

    # ---------- 推理 ----------
    def __call__(self, im: Image.Image) -> np.ndarray:
        if self.backend == "onnx":
            x = _to_nchw(im, self.size, config.IMAGENET_MEAN, config.IMAGENET_STD)
            outs = self.sess.run(None, {self.input_name: x})
            return l2(_pool(outs))

        if self.backend == "torch":
            import torchvision.transforms as T  # type: ignore

            tf = T.Compose([
                T.Resize(config.REID_SIZE),
                T.CenterCrop(config.REID_SIZE),
                T.ToTensor(),
                T.Normalize(config.IMAGENET_MEAN, config.IMAGENET_STD),
            ])
            with self.torch.no_grad():
                v = self.model(tf(im.convert("RGB")).unsqueeze(0).to(self.dev))
            return l2(v[0].float().cpu().numpy())

        # 占位：同一张图必定得到同一个向量，保证前后端联调时结果稳定可复现
        h = hashlib.sha256(im.convert("RGB").resize((16, 16)).tobytes()).digest()
        rng = np.random.RandomState(int.from_bytes(h[:4], "big"))
        return l2(rng.randn(self.dim).astype(np.float32))


class _Detector:
    """YOLO 猫体检测：先把猫从背景里框出来，再去提特征。

    为什么要这一步：整图提特征时，模型很容易「记住背景」（那只猫总在同一块草坪前），
    换个地方拍就认不出来了 —— 学术界叫 Background Problem。裁掉背景能明显提升准确率。
    COCO 里猫的类别 id 是 15。
    """

    CAT_CLASS = 15

    def __init__(self):
        self.sess = None
        self.size = 640
        self.path = _resolve_detect_model()
        if not self.path:
            log.info("未启用猫体检测（DETECT_ONNX 为空 / 关闭 / 自动发现不到模型），整图提特征")
            return
        try:
            import onnxruntime as ort  # type: ignore

            providers = ["CPUExecutionProvider"]
            if config.DEVICE in ("auto", "cuda"):
                if "CUDAExecutionProvider" in ort.get_available_providers():
                    providers.insert(0, "CUDAExecutionProvider")
            self.sess = ort.InferenceSession(self.path, providers=providers)
            self.input_name = self.sess.get_inputs()[0].name
            sh = self.sess.get_inputs()[0].shape
            self.size = int(sh[-1]) if isinstance(sh[-1], int) else 640
            log.info("检测模型就绪：%s input=%d %s", providers[0], self.size,
                     os.path.basename(self.path))
        except Exception as e:  # noqa: BLE001
            log.warning("检测模型加载失败，降级为整图提特征：%s: %s", type(e).__name__, e)
            self.sess = None

    def detect(self, im: Image.Image) -> Dict:
        """检测画面主体（猫），返回诊断完整的 dict。

        {'box': [x1,y1,x2,y2] | None, 'conf': float,
         'candidates': int, 'reason': str}

        `reason` 只在没框到时非空，用于区分三种「没框到」：
        没启用模型 / 模型没看到猫 / 框退化。三者在前端的处理相同（退回整图），
        但现场排查时差别很大 —— 前者是配置问题，后两者是素材问题。
        """
        if self.sess is None:
            return {"box": None, "core": None, "conf": 0.0, "candidates": 0,
                    "reason": "未启用检测模型" if not self.path else "检测模型加载失败"}

        w, h = im.size
        x = _to_nchw(im, self.size, (0, 0, 0), (1, 1, 1))
        out = self.sess.run(None, {self.input_name: x})[0]

        a = np.asarray(out)
        if a.ndim == 3:
            a = a[0]
        if a.shape[0] < a.shape[-1]:      # [4+nc, anchors] → 转置成 [anchors, 4+nc]
            a = a.T

        if a.shape[-1] < 6:
            return {"box": None, "core": None, "conf": 0.0, "candidates": 0, "reason": "检测输出形状异常"}
        raw_boxes, scores = a[:, :4], a[:, 4:]
        cls = scores.argmax(1)
        conf = scores.max(1)

        keep = np.where((conf > config.DETECT_CONF) & (cls == self.CAT_CLASS))[0]
        if not len(keep):
            return {"box": None, "core": None, "conf": 0.0, "candidates": 0, "reason": "模型没有识别到猫体"}

        # 原始输出（YOLOv5/v8/v11 一致）是 cxcywh + 输入坐标系，先统一还原成原图 xyxy
        cand_boxes, cand_confs = [], []
        for i in keep:
            b = _detect_box_to_xyxy(raw_boxes[i], w, h, self.size)
            if b:
                cand_boxes.append(b)
                cand_confs.append(float(conf[i]))
        if not cand_boxes:
            return {"box": None, "core": None, "conf": 0.0, "candidates": int(len(keep)), "reason": "检测框退化"}

        idx = _pick_subject(cand_boxes, cand_confs)
        core = cand_boxes[idx]
        box = _pad_box(core, w, h, config.DETECT_PAD)

        # 可选：把框扩成正方形再裁，避免整图提特征/裁得太扁时特征跑偏。
        # 默认关闭（见 config.DETECT_COLLAPSE_SQUARE 的长注释：开启需配合
        # embedder 按 crop 自己尺寸算缩放，本代码已满足）。
        if config.DETECT_COLLAPSE_SQUARE:
            x1, y1, x2, y2 = box
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
            side = max(x2 - x1, y2 - y1)
            half = max(1, side // 2)
            box = [max(0, cx - half), max(0, cy - half),
                   min(w, cx + half), min(h, cy + half)]

        return {"box": box, "core": core, "conf": round(cand_confs[idx], 3),
                "candidates": len(cand_boxes), "reason": ""}

    def __call__(self, im: Image.Image) -> Optional[List[int]]:
        """返回面积最大的猫框 [x1, y1, x2, y2]（原图坐标），没检测到返回 None。"""
        return self.detect(im)["box"]


class _AttrClassifier:
    """CLIP 零样本分类毛色 / 花纹。

    不训练、不标注：把候选标签写成自然语言句子，看图片更像哪一句。
    校园场景够用，而且 attributes 只是辅助展示，真正决定身份的是 embedding。
    """

    def __init__(self):
        self.ok = False
        if not config.USE_CLIP:
            return
        try:
            import open_clip  # type: ignore
            import torch  # type: ignore

            dev = "cuda" if (config.DEVICE in ("auto", "cuda") and torch.cuda.is_available()) else "cpu"
            self.torch, self.dev = torch, torch.device(dev)
            m, _, pre = open_clip.create_model_and_transforms(
                config.CLIP_MODEL, pretrained=config.CLIP_PRETRAINED
            )
            self.model = m.to(dev).eval()
            self.preprocess = pre
            self.tokenizer = open_clip.get_tokenizer(config.CLIP_MODEL)
            self.texts = list(config.COLOR_LABELS.values()) + list(config.PATTERN_LABELS.values())
            with torch.no_grad():
                self.tfeat = self.model.encode_text(self.tokenizer(self.texts).to(dev))
                self.tfeat /= self.tfeat.norm(dim=-1, keepdim=True)
            self.ok = True
            log.info("属性分类器就绪：CLIP %s", dev)
        except Exception as e:  # noqa: BLE001
            log.warning("CLIP 不可用，跳过属性识别：%s", e)

    def __call__(self, im: Image.Image) -> Tuple[str, str, float]:
        if not self.ok:
            return "", "", 0.0
        with self.torch.no_grad():
            t = self.preprocess(im.convert("RGB")).unsqueeze(0).to(self.dev)
            f = self.model.encode_image(t)
            f /= f.norm(dim=-1, keepdim=True)
            probs = (100.0 * f @ self.tfeat.T).softmax(dim=-1)[0].cpu().numpy()

        n_color = len(config.COLOR_LABELS)
        color_keys = list(config.COLOR_LABELS.keys())
        pattern_keys = list(config.PATTERN_LABELS.keys())
        ci = int(probs[:n_color].argmax())
        pi = int(probs[n_color:].argmax()) + n_color
        return color_keys[ci], pattern_keys[pi], float(probs[pi])


class Engine:
    def __init__(self):
        self.embedder = _Embedder()
        self.detector = _Detector()
        self.clf = _AttrClassifier()
        self.dim = self.embedder.dim

    @property
    def provider(self) -> str:
        return self.embedder.backend

    @property
    def attrs_ready(self) -> bool:
        """属性识别是否可用。

        CLIP 没开也照样有属性（`app/attrs.py` 的启发式兜底），所以这里恒为 True；
        保留它是为了让 /health 的语义从「有没有属性」细化成
        「走的是哪条路径」，优先级见 attr_source。
        """
        return True

    @property
    def attr_source(self) -> str:
        """当前属性识别的首选路径：clip（语义更准）/ api（远程）/ heuristic（色域）。"""
        if self.clf.ok:
            return "clip"
        if getattr(config, "ATTR_API_URL", ""):
            return "api"
        return "heuristic"

    def attrs(self, im: Image.Image, cropped: bool = False) -> dict:
        """属性识别：CLIP 优先，置信度不足或不可用时落到色域启发式。

        为什么是「CLIP 先、启发式后」而不是反过来：
          CLIP 在有条件装的环境下确实更准（能区分重点色、银渐层这类微妙花色），
          但它对 9×6 个候选做 softmax，置信度低于 0.5 基本等于瞎猜 ——
          这时启发式的「数像素」反而更可靠（橘猫就是橘色占多数，不需要语义理解）。

        返回结构见 app/attrs.py：color/pattern/breed/confidence/source/palette/reason。
        这个 dict 会原样进 /v1/recognize 的 features 和 meta，**不给前端假数据**：
        判不出来时 color 就是空字符串，附带 reason 说明原因。
        """
        clip = None
        try:
            color, pattern, conf = self.clf(im)
            conf = float(conf or 0.0)
            if color and pattern and conf >= config.ATTR_CONF_MIN:
                clip = {
                    "color": color,
                    "pattern": pattern,
                    "breed": attr_heuristic._breed_of(color, pattern),
                    "confidence": round(conf, 3),
                    "source": "clip",
                    "palette": [],
                    "stripe": 0.0,
                    "reason": "",
                }
            elif color or pattern:
                # 保留 CLIP 的低置信结果作为最后兜底，但 reason 必须写清楚
                # 「仅供参考」—— 上层据此决定是否直接展示，别当确凿结论用。
                clip = {
                    "color": color,
                    "pattern": pattern,
                    "breed": attr_heuristic._breed_of(color, pattern),
                    "confidence": round(conf, 3),
                    "source": "clip",
                    "palette": [],
                    "stripe": 0.0,
                    "reason": "模型置信度低于 %d%%，仅供参考" % int(config.ATTR_CONF_MIN * 100),
                }
        except Exception as e:  # noqa: BLE001 —— 属性失败绝不能拖垮识别
            log.warning("CLIP 属性分类异常，改用色域分析：%s: %s", type(e).__name__, e)

        if clip and not clip["reason"]:
            return clip

        got = attr_heuristic.detect(im, cropped=cropped)
        if got.get("color"):
            return got
        # 启发式也判不出来 → 退回 CLIP 的低置信结果（有就带上说明）
        return clip or got

    def _embed(self, im: Image.Image) -> np.ndarray:
        """提一条 L2 归一化向量，并做维度自检。

        长宽比保护：embedder 按**传进来的这张图**自己的尺寸算 letterbox 缩放系数，
        所以「先按框裁出任意长宽比的 crop、再交给 embedder」是安全的（见 _letterbox）。
        早期是拿原图的系数去缩 crop，518×293 的框会得到 1370 宽的张量，
        报 "Attempting to broadcast an axis by a dimension other than 1. 257 by 1370"。

        维度自检：_pool 若因骨干换导出方式而取错层，向量会变成几十万维，
        存进特征库后与其它猫矩阵乘会直接广播报错。宁可当场失败也不要污染特征库。
        """
        emb = np.asarray(self.embedder(im), dtype=np.float32).reshape(-1)
        if self.dim and emb.shape[0] != int(self.dim):
            raise RuntimeError(
                f"特征维度异常：期望 {int(self.dim)}，实际 {emb.shape[0]}"
                f"（骨干导出方式变了？请检查 engine._pool 与 REID_ONNX）")
        return emb

    def features_ex(self, im: Image.Image, box=_AUTO_BOX) -> Tuple[np.ndarray, bool, dict]:
        """返回 (embedding, 是否检测到猫体, 属性 dict)。

        `box` 可传入外部已算好的框（多帧复用时用），默认自己检测。
        与 features() 的差别只是把属性从 3 个标量升级成完整 dict（含品种、
        来源、色板占比、失败原因），/v1/recognize 需要这些诊断信息。
        """
        if box is _AUTO_BOX:
            det = _run_detect(self.detector, im)
            box = det["box"]
            core = det.get("core") or box
        else:
            core = box
        crop = im.crop(box) if box else im
        # 花色用紧绷框（理由见 analyze_frames），提特征用外扩框
        attr_im = im.crop(core) if core else im
        # cropped=True 告诉属性分析「这已是紧贴猫体的裁剪图」，
        # 别再套中央椭圆（会削掉耳朵和尾巴）。
        return self._embed(crop), box is not None, self.attrs(attr_im, cropped=box is not None)

    def analyze_frames(self, frames: List[Image.Image]) -> dict:
        """识别主流程：检测一次 → 所有帧复用同一个框 → 提特征 → 选最清楚的一帧判花色。

        三个设计点，都是踩过坑才定下来的：

        ① **检测只跑一次**。视频相邻帧几乎一样，逐帧检测要付 N 次 ~65ms，换来的框
           却基本重合。更要紧的是复用同一个框让**多帧平均有意义** —— 每帧各裁各的，
           视野不一致（猫挪了、框抖了），平均出来的向量反而更糊。
        ② **检测帧从中间挑，失败再试首/尾**。中间帧通常既不是用户截的封面（可能糊），
           也不是片尾转身；万一中间帧真没猫（镜头扫过去），再试首尾，代价只是一次
           额外推理，而不是整段视频退化成整图提特征。
        ③ **属性聚合而非挑帧**（2026-10-25 升级，此前是「取置信度最高的那一帧」）。
           置信度只反映「这一帧颜色多集中」，不反映「结论多可靠」—— 糊帧/逆光帧
           照样能给高置信的错误结论，而多数帧的正确结论被无视。现在把各帧的
           中间统计量（色板占比/暗灰/条纹）加权平均后**统一判定**，各帧独立
           结论的一致率折进置信度，分歧写进 reason。见 attrs.merge_and_decide。
           CLIP 帧没有中间统计量，维持「取最高置信」的旧行为（由聚合器兜底）。
        """
        n = len(frames)
        mid = n // 2
        order = [mid] + [i for i in range(n) if i != mid]

        t_det = time.time()
        det = {"box": None, "core": None, "conf": 0.0, "candidates": 0, "reason": "没有可用帧"}
        det_i = order[0] if order else 0
        for tried, i in enumerate(order, 1):
            det_i = i
            det = _run_detect(self.detector, frames[i])
            if det["box"] or tried >= 3:     # 首/中/尾各试一次就够，别把 N 帧全跑一遍
                break
        detect_ms = int((time.time() - t_det) * 1000)

        box = det["box"]
        # 猫体区域平均亮度（低光门控用，见 _quality）：必须在**喂给嵌入模型的
        # 同一个框**（外扩框 crop）上算 —— 嵌入不可信的根源就是这些像素。
        # 只算检测帧一次：一段视频/一张图光照恒定，逐帧算是白花 CPU。
        light = self._box_light(frames[det_i], box)
        # 花色用**紧绷框**、提特征用**外扩框**：两者诉求相反。
        # 外扩能补回被切掉的耳尖/尾巴（个体特征更完整），但每扩一圈都会带进
        # 背景和杂物 —— 实测 8% 外扩把绿墙和木桌算进色域，白猫从「纯白」变成
        # 「颜色不集中」判不出来。所以色彩统计坚持用没外扩的那个框。
        core = det.get("core") or box
        embs, frame_attrs = [], []
        t_emb = time.time()
        for im in frames:
            crop = im.crop(box) if box else im
            embs.append(self._embed(crop))
            frame_attrs.append(self.attrs(im.crop(core) if core else im, cropped=bool(box)))
        embed_ms = int((time.time() - t_emb) * 1000)

        # 属性结论：优先多帧聚合（含单帧 —— 单帧时聚合器等价于原样返回），
        # 聚合器不适用（全是 CLIP 帧 / 全判不出）时退回「最高置信帧」的旧行为。
        best_attr = None
        for a in frame_attrs:
            if a.get("color") and (best_attr is None or a["confidence"] > best_attr["confidence"]):
                best_attr = a
        merged = attr_heuristic.merge_and_decide(frame_attrs)
        attr = merged or best_attr

        return {
            "embs": embs,
            "detected": bool(box),
            "box": box,
            "core": core,
            "detectConf": float(det.get("conf") or 0.0),
            "detectCandidates": int(det.get("candidates") or 0),
            "detectReason": det.get("reason") or "",
            "attr": attr,
            "quality": self._quality(box, frames[0].size if frames else None, light=light),
            "timing": {"detect": detect_ms, "embed": embed_ms},
        }

    @staticmethod
    def _box_light(im, box) -> Optional[float]:
        """猫体区域（外扩框 crop）的平均亮度（HSV 的 V，0~255）。

        低光门控的输入信号。96×96 采样足够（9216 个样本），单次 <1ms。
        没框（检测失败走整图）时也照算 —— 整图提特征本来就不可信，
        低光只是雪上加霜，返回整图亮度供诊断。
        """
        try:
            crop = im.crop(box) if box else im
            hsv = np.asarray(crop.resize((96, 96)).convert("HSV"))
            return float(hsv[..., 2].mean())
        except Exception:        # noqa: BLE001 —— 亮度算不出来只放弃门控，不拦识别
            return None

    @staticmethod
    def _quality(box, frame_size, light=None) -> dict:
        """查询图可信度：**猫占多大** + **光线够不够**。任一不过 → 放弃结论。

        为什么需要（2026-10-26 实测，不是理论）
        ------------------------------------
        维度一「占比」：用户上传夜间实拍：白猫站在远处台面上，检测框只占画面 4.9%。
        结果：查询向量与「白猫档案」余弦 61.5%，与「橘猫档案」63.8% ——
        **方向都反了**，界面给出「胖橘 83%」这种一眼假的结论。
        同一次实验里，把同一只白猫按比例缩小做对照：
            占画面 39.5% → 差值 +25.5%（正确）
            占画面 28.2% → 差值 +15.7%（正确）
            占画面  8.5% → 差值 +12.9%（正确）
            占画面  3.2% → 差值 +5.0%（正确）
            检测框退化 → 差值 −2.4% ~ −3.2%（全线配错）
        结论：区分度随目标变小单调下降，框一旦退化物里查询向量就不再可信。

        维度二「亮度」（同日深夜第二例，占比门控拦不住）：夜间白猫**近拍**，
        框占画面 47%，但花色判「黑猫 0.824」（白毛 V 92~184 全掉进 gray/black 桶，
        夜里 p98=242 被点光源占据，曝光自适应锚点失效），检索把白天白猫档案排在
        英短后面（53.7% < 57.5%，方向反了），线上给出「胖橘 79.7%」。
        gamma 亮度增强救不回来（增强后仍排第二）。实测猫体平均 V：
        夜间 105 / 113，白天 8 张全部 ≥178 —— 两簇间隔 >50，阈值取中 125。
        ⚠️ 早期结论「压暗 0.4 倍区分度仍有 +17.7%，不用看亮度」只对**模拟压暗**
        成立；真实夜间照（点光源 + 色偏 + 相机降噪）是另一个分布。

        门控口径：任一维度不过 → **不返回候选匹配、花色也弃权**：硬给结论比
        说"看不清"更糟 —— 用户会照着错误结果去点「就是这只猫」，把错样本
        写进特征库。
        """
        if not box or not frame_size:
            return {"ok": False, "areaRatio": 0.0,
                    "reason": "未定位到猫体（整图提特征，背景会污染结果）"}
        fw, fh = frame_size
        if fw <= 0 or fh <= 0:
            return {"ok": False, "areaRatio": 0.0, "reason": "画面尺寸异常"}
        ratio = (box[2] - box[0]) * (box[3] - box[1]) / float(fw * fh)
        if ratio < float(config.QG_MIN_AREA_RATIO):
            return {"ok": False, "areaRatio": round(ratio, 4),
                    "reason": "猫在画面里只占 %.0f%%，距离太远，特征不足以可靠比对"
                              % (100.0 * ratio)}
        # 低光门控：⚠️ 必须显式 None 判断（None = 没算出来，门控不生效），
        # 不能写 `if not light` —— V=0.0 是合法的（全黑图）会被 or 链吞掉。
        if light is not None and light < float(config.QG_MIN_LIGHT_MEAN_V):
            return {"ok": False, "areaRatio": round(ratio, 4),
                    "lightMeanV": round(light, 1),
                    "reason": "光线太暗，拍到的细节不足以可靠比对，请靠近光源重拍"}
        return {"ok": True, "areaRatio": round(ratio, 4),
                "lightMeanV": None if light is None else round(light, 1),
                "reason": ""}

    def features(self, im: Image.Image) -> Tuple[np.ndarray, str, str, float, bool]:
        """返回 (embedding, color, pattern, attr_conf, detected)。

        兼容旧签名的薄封装 —— 需要品种 / 来源 / 失败原因时用 features_ex。
        """
        emb, detected, a = self.features_ex(im)
        return emb, a["color"], a["pattern"], a["confidence"], detected


_engine: Optional[Engine] = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = Engine()
    return _engine
