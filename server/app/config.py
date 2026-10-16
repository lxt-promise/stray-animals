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
# ⚠️ 默认 224 对应镜像里那版 reid.onnx（patch=14，token 数 257）。
# 换成别的骨干后即使这里没改也不会 500 —— engine._probe_input_size 会按模型
# 输出的 token 数反推边长并用一次空推理校验。REID_SIZE 只是「首选值」。
REID_SIZE = _i("REID_SIZE", 224)
# 特征算法版本：池化策略等变更时递增。写进 COS 对象头（1 字节），
# 读取时版本不符的对象直接跳过 —— 防止换算法后新旧向量（同维不同义）混算乱匹配。
FEATURE_POOL_VERSION = _i("FEATURE_POOL_VERSION", 2)   # v1=mean-pool, v2=CLS
REID_TORCH = _s("REID_TORCH", "timm/vit_large_patch14_dinov2.lvd142m")

DETECT_ONNX = _s("DETECT_ONNX")
DETECT_CONF = _f("DETECT_CONF", 0.35)
# 检测到的猫框是否**折叠成正方形**再裁剪。
#
# 为什么出厂默认 false（true 会在生产上引发 500，2026-10-15 实测）：
# embedder 按传给它的图片**自己的**尺寸算 letterbox 缩放系数（s = size/max(w,h)），
# 所以「先按框裁出任意长宽比的 crop、再交给 embedder」是正确的；
# 而一旦把框折成正方形（为了不让整图提特征跑偏），裁出的 crop 尺寸就和原图脱钩，
# 极端框（如 518×293）会让缩放系数失效、缩放后的一边远超模型输入边长，
# ONNX 直接报 "Attempting to broadcast an axis by a dimension other than 1. 257 by 1370"。
# 想开启的部署必须同时确认 embedder 用 crop 尺寸算缩放（本代码已如此），
# 并接受「整图提特征」这条路径本身没有裁剪收益。
DETECT_COLLAPSE_SQUARE = _b("DETECT_COLLAPSE_SQUARE", False)

USE_CLIP = _b("USE_CLIP")
CLIP_MODEL = _s("CLIP_MODEL", "ViT-B-32")
CLIP_PRETRAINED = _s("CLIP_PRETRAINED", "laion2b_s34b_b79k")

INDEX_DB = Path(_s("INDEX_DB", "/data/catcampus/index.sqlite3"))

# 特征库后端：sqlite（本地文件，默认）| cos（腾讯云对象存储）。
# 云托管等无持久盘环境必须用 cos，否则容器一重建特征库就归零。
INDEX_BACKEND = _s("INDEX_BACKEND", "sqlite")
# COS 后端参数（INDEX_BACKEND=cos 时必配前四个）
COS_SECRET_ID = _s("COS_SECRET_ID")
COS_SECRET_KEY = _s("COS_SECRET_KEY")
COS_TOKEN = _s("COS_TOKEN")              # 仅临时密钥场景需要
COS_BUCKET = _s("COS_BUCKET")
COS_REGION = _s("COS_REGION")            # 如 ap-shanghai
COS_ENDPOINT = _s("COS_ENDPOINT")        # 一般留空走默认；VPC 内可填内网 endpoint
# COS 内的对象键前缀，每猫一对象：<INDEX_PREFIX><cat_id>.bin
INDEX_PREFIX = _s("INDEX_PREFIX", "index/")

FFMPEG = _s("FFMPEG", "ffmpeg")
FFPROBE = _s("FFPROBE", "ffprobe")
MAX_FRAMES = _i("MAX_FRAMES", 8)
FETCH_TIMEOUT = _i("FETCH_TIMEOUT", 15)

# 素材下载大小上限（字节）：历史上 r.content 一次性全量入内存，
# 一个几百 MB 的视频 URL 即可打爆容器内存限额
MAX_IMAGE_BYTES = _i("MAX_IMAGE_BYTES", 10 * 1024 * 1024)
MAX_VIDEO_BYTES = _i("MAX_VIDEO_BYTES", 100 * 1024 * 1024)

# 是否拒绝「私有地址段」的素材 URL（SSRF 纵深防御）。
# 默认 false：本地/内网部署时 asset-base-url 常是 127.0.0.1，开了会误伤；
# 部署到公网且确认素材都在公网可达地址时，设为 true。
# 云元数据地址（169.254.0.0/16）无论此项都拒绝。
BLOCK_PRIVATE_URLS = _b("BLOCK_PRIVATE_URLS", False)

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
