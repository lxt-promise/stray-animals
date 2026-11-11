# -*- coding: utf-8 -*-
"""前景抠图（u2netp，纯 CPU，模型 4.3MB）。

为什么识别链路需要它（2026-10-31 实测，19 张东南大学实拍图）
--------------------------------------------------------
检测框只能**框住**猫，框里仍有墙、地板、床单。这些背景像素会同时污染两件事：

  1. **花色统计**：纯黑猫（玄猫）站在白背景前，白墙被算进 white 桶 →
     判成「黑白奶牛猫」；玳瑁的暖色底毛被背景稀释 → 判成狸花。抠图后
     只统计猫毛像素，两张玄猫都回到 black。
  2. **个体特征**：背景是 embeddings 最容易被记住的部分（Background Problem），
     换个地方拍同一只猫就认不出。把背景替换成中性灰，同猫两张照片的余弦
     从 0.540 提到 0.720（橘猫 2 模糊图 vs 清晰图）。

实现要点：
  - 与 `tools/remove_bg.py` 共用**同一套预处理/后处理**（那里只是包了一层 CLI）。
    模型输入固定 320×320、ImageNet 归一化，输出单通道显著度，min-max 归一化后
    上采样回原尺寸；
  - 会话**懒加载 + 加锁**：首次调用 ~300ms，之后同一会话复用，单张推理
    （320×320，CPU）约 0.3~0.5s，这是本模块唯一的固定开销；
  - 任何异常一律 `ok=False` 让调用方退回旧行为 —— 抠图是加分项，不能成为
    识别链路的单点故障（这条与项目其它降级纪律一致）。
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Optional

import numpy as np
from PIL import Image

from . import config

log = logging.getLogger("catcampus.matting")

_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT_SIZE = 320
# ImageNet 均值/方差（u2netp 训练口径，与 tools/remove_bg.py 一致）
MEAN = np.array((0.485, 0.456, 0.406), dtype=np.float32)
STD = np.array((0.229, 0.224, 0.225), dtype=np.float32)

_sess = None
_sess_path = ""
_lock = threading.Lock()


def model_path() -> str:
    """决定用哪个抠图模型；空串 = 不启用。规则同检测模型（见 engine._resolve_detect_model）：
    显式关闭 > 显式路径 > 自动发现 models/u2netp.onnx。"""
    raw = (getattr(config, "MATTING_ONNX", "") or "").strip()
    if raw.lower() in ("0", "off", "none", "false", "no"):
        return ""
    if raw:
        return raw
    if not getattr(config, "MATTING_AUTO", True):
        return ""
    cand = os.path.join(_SERVER_DIR, "models", "u2netp.onnx")
    return cand if os.path.exists(cand) else ""


def enabled() -> bool:
    return bool(model_path())


def _session(path: str):
    global _sess, _sess_path
    with _lock:
        if _sess is not None and _sess_path == path:
            return _sess
        import onnxruntime as ort  # type: ignore

        providers = ["CPUExecutionProvider"]
        if config.DEVICE in ("auto", "cuda"):
            if "CUDAExecutionProvider" in ort.get_available_providers():
                providers.insert(0, "CUDAExecutionProvider")
        _sess = ort.InferenceSession(path, providers=providers)
        _sess_path = path
        log.info("抠图模型就绪：%s (%s)", providers[0], os.path.basename(path))
        return _sess


def _mask_320(im: Image.Image) -> Optional[np.ndarray]:
    """跑一次 u2netp，返回 320×320 的 0~1 掩膜（float32，越大越像前景）。"""
    path = model_path()
    if not path:
        return None
    try:
        sess = _session(path)
        input_name = sess.get_inputs()[0].name
        small = im.convert("RGB").resize((INPUT_SIZE, INPUT_SIZE), Image.LANCZOS)
        arr = np.asarray(small, dtype=np.float32) / 255.0
        arr = (arr - MEAN) / STD
        x = np.transpose(arr, (2, 0, 1))[None, ...].astype(np.float32)
        out = sess.run(None, {input_name: x})[0]
        m = np.asarray(out, dtype=np.float32).reshape(-1, INPUT_SIZE, INPUT_SIZE)[0]
        lo, hi = float(m.min()), float(m.max())
        if hi - lo > 1e-6:
            m = (m - lo) / (hi - lo)
        else:
            m = np.zeros_like(m)
        return np.clip(m, 0, 1)
    except Exception as e:  # noqa: BLE001 —— 抠图失败只降级，不阻断识别
        log.warning("抠图推理失败，按不抠图继续：%s: %s", type(e).__name__, e)
        return None


def foreground(im: Image.Image) -> dict:
    """前景分析。返回：

    {'ok': bool, 'mask': H×W float32（原图尺寸）, 'box': [x1,y1,x2,y2],
     'coverage': float（掩膜占 crop 面积的比例）, 'tight': float（外接框占 crop 的面积）}

    `box` 是掩膜的外接框（原图坐标），比检测框更贴合猫体；`tight` 用来判断
    检测框是否「明显宽松」——两者差距大说明框里有大片背景，值得收紧。
    """
    out = {"ok": False, "mask": None, "box": None, "coverage": 0.0, "tight": 0.0}
    m320 = _mask_320(im)
    if m320 is None:
        return out
    w, h = im.size
    if w < 8 or h < 8:
        return out
    thr = float(getattr(config, "MATTING_ALPHA_THR", 0.5))
    ys, xs = np.where(m320 > thr)
    if not len(xs):
        return out
    # 掩膜上采样回原图尺寸：合成与色域统计都要逐像素用，留 320 会糊掉毛边
    full = m320
    if (w, h) != (INPUT_SIZE, INPUT_SIZE):
        full = np.asarray(
            Image.fromarray((m320 * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS),
            dtype=np.float32) / 255.0
    sx, sy = w / float(INPUT_SIZE), h / float(INPUT_SIZE)
    x1, y1 = int(xs.min() * sx), int(ys.min() * sy)
    x2, y2 = int((xs.max() + 1) * sx), int((ys.max() + 1) * sy)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, max(x1 + 1, x2)), min(h, max(y1 + 1, y2))
    coverage = float((m320 > thr).mean())
    tight = ((x2 - x1) * (y2 - y1)) / float(w * h)
    return {"ok": True, "mask": full, "box": [x1, y1, x2, y2],
            "coverage": coverage, "tight": tight}


def compose(im: Image.Image, mask: np.ndarray,
            bg: Optional[int] = None) -> Image.Image:
    """把背景替换成中性灰，只留前景 —— 提特征用。

    为什么用灰而不是黑/白：黑底会让白猫的毛边对比过强、白底会让黑猫过曝；
    128 灰是模型训练分布里最常见的「无信息背景」，与 ImageNet 归一化后的 0 对应。
    """
    if mask is None:
        return im
    w, h = im.size
    m = mask
    if m.shape[:2] != (h, w):
        m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS),
                       dtype=np.float32) / 255.0
    color = int(getattr(config, "MATTING_BG", 128) if bg is None else bg)
    arr = np.asarray(im.convert("RGB"), dtype=np.float32)
    mm = m[..., None]
    return Image.fromarray((arr * mm + color * (1.0 - mm)).astype(np.uint8))


def fg_stats(im: Image.Image, mask: np.ndarray) -> dict:
    """前景亮度/饱和度统计（门控与低光白猫判定用）。

    - vmean / vmed：猫毛像素的平均/中位亮度（HSV 的 V，0~255）；
    - sat：平均饱和度。白猫即便在夜里也是低饱和的（实测 27~30），黑猫
      的 JPG 彩色噪点反而偏高（68~90），这是两者在夜里最稳的区别；
    - bright：**亮毛占比**（V≥170 且 S≤60）。白猫 0.98、夜里的白猫 0.11、
      玄猫 0.001~0.002 —— 差两个数量级，用于低光下把「欠曝的白毛」从
      「真黑毛」里救回来（见 attrs._decide 的规则 8b）。
    """
    try:
        w, h = im.size
        m = mask
        if m is None or m.shape[:2] != (h, w):
            return {"vmean": None, "vmed": None, "sat": None, "bright": None}
        fg = m >= float(getattr(config, "MATTING_ALPHA_THR", 0.5))
        if not bool(fg.any()):
            return {"vmean": None, "vmed": None, "sat": None, "bright": None}
        hsv = np.asarray(im.convert("HSV"))
        v = hsv[..., 2][fg].astype(np.float32)
        s = hsv[..., 1][fg].astype(np.float32)
        bv = float(getattr(config, "ATTR_BRIGHT_V", 170.0))
        bs = float(getattr(config, "ATTR_BRIGHT_S", 60.0))
        return {"vmean": float(v.mean()), "vmed": float(np.median(v)),
                "sat": float(s.mean()),
                "bright": float(((v >= bv) & (s <= bs)).mean())}
    except Exception:  # noqa: BLE001
        return {"vmean": None, "vmed": None, "sat": None, "bright": None}


__all__ = ["enabled", "model_path", "foreground", "compose", "fg_stats"]
