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
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image

from . import config

log = logging.getLogger("catcampus.engine")


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
        if not config.DETECT_ONNX:
            log.info("未配置 DETECT_ONNX，跳过检测，直接整图提特征")
            return
        try:
            import onnxruntime as ort  # type: ignore

            providers = ["CPUExecutionProvider"]
            if config.DEVICE in ("auto", "cuda"):
                if "CUDAExecutionProvider" in ort.get_available_providers():
                    providers.insert(0, "CUDAExecutionProvider")
            self.sess = ort.InferenceSession(config.DETECT_ONNX, providers=providers)
            self.input_name = self.sess.get_inputs()[0].name
            sh = self.sess.get_inputs()[0].shape
            self.size = int(sh[-1]) if isinstance(sh[-1], int) else 640
            log.info("检测模型就绪：%s input=%d", providers[0], self.size)
        except Exception as e:  # noqa: BLE001
            log.warning("检测模型加载失败，降级为整图提特征：%s", e)
            self.sess = None

    def __call__(self, im: Image.Image) -> Optional[List[int]]:
        """返回面积最大的猫框 [x1, y1, x2, y2]（原图坐标），没检测到返回 None。"""
        if self.sess is None:
            return None
        w, h = im.size
        x = _to_nchw(im, self.size, (0, 0, 0), (1, 1, 1))
        out = self.sess.run(None, {self.input_name: x})[0]

        a = np.asarray(out)
        if a.ndim == 3:
            a = a[0]
        if a.shape[0] < a.shape[-1]:      # [4+nc, anchors] → 转置成 [anchors, 4+nc]
            a = a.T

        if a.shape[-1] < 6:
            return None
        boxes, scores = a[:, :4], a[:, 4:]
        cls = scores.argmax(1)
        conf = scores.max(1)

        keep = np.where((conf > config.DETECT_CONF) & (cls == self.CAT_CLASS))[0]
        if not len(keep):
            return None

        # 取置信度最高的候选框
        b = boxes[keep][conf[keep].argmax()]
        if b.max() <= 1.5:                # 归一化的 cx,cy,w,h → 转成像素 xyxy
            cx, cy, bw, bh = b
            box = [
                int(max(0, (cx - bw / 2) * w)), int(max(0, (cy - bh / 2) * h)),
                int(min(w, (cx + bw / 2) * w)), int(min(h, (cy + bh / 2) * h)),
            ]
        else:
            x1, y1, x2, y2 = b
            sx, sy = w / self.size, h / self.size
            box = [int(x1 * sx), int(y1 * sy), int(x2 * sx), int(y2 * sy)]

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
        return box


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

    def features(self, im: Image.Image) -> Tuple[np.ndarray, str, str, float, bool]:
        """返回 (embedding, color, pattern, detect_conf, detected)。

        检测到猫就用裁剪图提特征；检测不到（或没配检测模型）就退化为整图。
        """
        box = self.detector(im)
        crop = im.crop(box) if box else im

        # 长宽比保护：embedder 按**原图**算 letterbox 缩放系数，裁剪后的 crop 若形状
        # 和原图差得多（检测框很扁/很窄），缩放系数就失效 —— 极端情况下 crop 的一边
        # 会被缩到远超输入边长（实测踩过：518×293 的框喂给 224 的模型会得到
        # 1370 宽的张量，报 "Attempting to broadcast an axis by a dimension other
        # than 1. 257 by 1370"）。直接在 embedder 里按 crop 自己的尺寸缩放，
        # 这里的 crop 就是最终输入。
        emb = np.asarray(self.embedder(crop), dtype=np.float32).reshape(-1)

        # 维度自检：_pool 若因骨干换导出方式而取错层，向量会变成几十万维，
        # 存进特征库后与其它猫矩阵乘会直接广播报错。宁可当场失败也不要污染特征库。
        if self.dim and emb.shape[0] != int(self.dim):
            raise RuntimeError(
                f"特征维度异常：期望 {int(self.dim)}，实际 {emb.shape[0]}"
                f"（骨干导出方式变了？请检查 engine._pool 与 REID_ONNX）")

        color, pattern, conf = self.clf(crop)
        return emb, color, pattern, conf, box is not None


_engine: Optional[Engine] = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = Engine()
    return _engine
