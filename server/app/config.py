"""统一配置读取。所有开关都能用环境变量覆盖，方便 Docker 部署时注入。"""
import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv 非必需
    pass


def _s(key: str, default: str = "") -> str:
    v = os.getenv(key, default)
    return v.strip() if isinstance(v, str) else v


def _i(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, default))
    except (TypeError, ValueError):
        return default


def _f(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, default))
    except (TypeError, ValueError):
        return default


def _b(key: str, default: bool = False) -> bool:
    return _s(key, "1" if default else "0").lower() in ("1", "true", "yes", "on")


API_TOKEN = _s("API_TOKEN")
DEVICE = _s("DEVICE", "auto")

REID_ONNX = _s("REID_ONNX")
REID_SIZE = _i("REID_SIZE", 518)
REID_TORCH = _s("REID_TORCH", "timm/vit_large_patch14_dinov2.lvd142m")

DETECT_ONNX = _s("DETECT_ONNX")
DETECT_CONF = _f("DETECT_CONF", 0.35)

USE_CLIP = _b("USE_CLIP")
CLIP_MODEL = _s("CLIP_MODEL", "ViT-B-32")
CLIP_PRETRAINED = _s("CLIP_PRETRAINED", "laion2b_s34b_b79k")

INDEX_DB = Path(_s("INDEX_DB", "/data/catcampus/index.sqlite3"))
FFMPEG = _s("FFMPEG", "ffmpeg")
FFPROBE = _s("FFPROBE", "ffprobe")
MAX_FRAMES = _i("MAX_FRAMES", 8)
FETCH_TIMEOUT = _i("FETCH_TIMEOUT", 15)

# ImageNet 归一化常量（DINOv2 / CLIP 都用这一组）
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)

# CLIP zero-shot 用的毛色 / 花纹标签（中文回写给前端，英文送给模型）
COLOR_LABELS = {
    "橘猫": "a ginger orange cat",
    "狸花": "a brown tabby cat with stripes",
    "黑白": "a black and white tuxedo cat",
    "纯白": "a solid white cat",
    "纯黑": "a solid black cat",
    "灰色": "a gray blue cat",
    "三花": "a calico tortoiseshell cat",
    "玳瑁": "a tortoiseshell brindle cat",
    "重点色": "a siamese pointed cream cat",
}
PATTERN_LABELS = {
    "tabby": "a tabby striped cat",
    "solid": "a solid color cat with no pattern",
    "cow": "a bicolor black and white cow cat",
    "calico": "a calico patched cat",
    "pointed": "a pointed colorpoint cat",
    "spotted": "a spotted cat",
}
