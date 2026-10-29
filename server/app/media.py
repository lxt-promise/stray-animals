"""素材获取：下载图片、用 ffmpeg 抽视频帧。

ffmpeg 是自建服务相对云函数的最大优势 —— 微信云函数的 Node 运行环境里没有 ffmpeg，
视频只能拿封面帧凑合；自建服务器上可以任意装系统包，真抽帧才走得通。
"""
from __future__ import annotations

import ipaddress
import logging
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional

import httpx
from PIL import Image

from . import config

log = logging.getLogger("catcampus.media")

_client: Optional[httpx.Client] = None

# 云元数据地址 / 主机名：无论配置如何都拒绝（SSRF 的头号目标）
_METADATA_HOSTS = {"metadata.google.internal", "metadata.goog", "instance-data"}


def _http() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=config.FETCH_TIMEOUT, follow_redirects=True)
    return _client


def _assert_safe_url(url: str) -> None:
    """SSRF 纵深防御（Java 侧已有同源校验，这里是第二道闸）。

    - 只允许 http/https（挡 file://、gopher:// 等）
    - 始终拒绝云元数据地址（169.254.0.0/16 与已知元数据主机名）
    - BLOCK_PRIVATE_URLS=true 时额外拒绝全部私有/回环/链路本地地址
      （默认关：本地部署的 asset-base-url 常是 127.0.0.1，开了会误伤）
    """
    from urllib.parse import urlparse

    u = urlparse(url)
    if u.scheme not in ("http", "https"):
        raise ValueError(f"不允许的 URL 协议: {u.scheme!r}")
    host = (u.hostname or "").lower()
    if not host:
        raise ValueError("URL 缺少主机名")
    if host in _METADATA_HOSTS:
        raise ValueError("不允许访问云元数据地址")

    def _reject(ip_text: str) -> bool:
        try:
            ip = ipaddress.ip_address(ip_text)
        except ValueError:
            return False
        if ip.is_link_local:
            return True
        if config.BLOCK_PRIVATE_URLS and (ip.is_private or ip.is_loopback):
            return True
        return False

    # 字面量 IP 直接判断；域名做一次解析（生产可换 DoH/固定 Egress）
    if _reject(host):
        raise ValueError(f"不允许的内网地址: {host}")
    try:
        ip_text = socket.gethostbyname(host)
    except Exception:
        return   # 解析失败交给下载环节报错，不在这里硬拦
    if _reject(ip_text):
        raise ValueError(f"不允许的内网地址: {host} -> {ip_text}")


class DownloadError(Exception):
    """下载失败，携带**可判读的原因码**。

    为什么要有：2026-10-24「重建特征库部分失败」的现场里，日志只有
    `下载失败 <url>: Client error '403 Forbidden'`，看不出这是「临时链接过期」，
    也分不出是 403（过期/无权限）还是 404（文件已删）。而这两者的处置完全不同：
    403 换一条链接就好（文件还在），404 只能让用户重传。
    所以把状态码提炼成 reason 码（http403 / http404 / http40x / timeout / tooLarge …），
    让它一路传到 /v1/index/build 的 reasons 里。
    """

    def __init__(self, reason: str, detail: str = ""):
        self.reason = reason
        self.detail = detail
        super().__init__(detail or reason)


def _download(url: str, max_bytes: int, timeout: Optional[float] = None) -> bytes:
    """带大小上限的下载。历史上 r.content 一次性全量入内存，
    一个几百 MB 的 URL 就能打爆容器内存限额。

    timeout：本次下载的超时（秒），None 用连接池的默认 FETCH_TIMEOUT。
    识别热路径必须传一个小的值 —— 补库是「顺手做」的副作用，
    单张照片不该独占云函数给 AI 的 1.8s 窗口（见 _ensure_index_inner）。
    """
    _assert_safe_url(url)
    kw = {"timeout": timeout} if timeout else {}
    try:
        with _http().stream("GET", url, **kw) as r:
            if r.status_code != 200:
                # 403 大概率是云开发临时链接过期（sign 有时效），404 是文件已删 ——
                # 状态码必须带出去，否则建库失败原因全是同一个「downloadFailed」。
                if r.status_code in (401, 403):
                    raise DownloadError("http403", f"HTTP {r.status_code}（多为临时链接已过期）")
                if r.status_code == 404:
                    raise DownloadError("http404", f"HTTP 404（文件已不存在）")
                raise DownloadError("http%d" % r.status_code, "HTTP %d" % r.status_code)
            length = r.headers.get("content-length")
            if length and int(length) > max_bytes:
                raise DownloadError(
                    "tooLarge", f"素材超过大小上限（{int(length)} > {max_bytes} 字节）")
            chunks = []
            total = 0
            for chunk in r.iter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise DownloadError("tooLarge", f"素材超过大小上限（>{max_bytes} 字节）")
                chunks.append(chunk)
            return b"".join(chunks)
    except httpx.TimeoutException as e:
        raise DownloadError("timeout", str(e)) from e
    except httpx.HTTPError as e:
        raise DownloadError("network", "%s: %s" % (type(e).__name__, e)) from e


def fetch_image_ex(url: str, timeout: Optional[float] = None):
    """下载一张图，**带失败原因码**。

    @returns {(Image|None, str)} 成功时 reason 为空串；失败时 img 为 None，
      reason ∈ http403 / http404 / http4xx / timeout / network / tooLarge / badImage /
      unsafeUrl / emptyUrl。

    保留 `fetch_image`（见下）是因为它已经在大量调用点与测试里作为「签名」存在，
    这里不去动它，新增一个能要诊断信息的版本。
    """
    if not url:
        return None, "emptyUrl"
    try:
        data = _download(url, config.MAX_IMAGE_BYTES, timeout=timeout)
        return _decode_image(data), ""
    except DownloadError as e:
        log.warning("下载失败 %s：%s", url[:80], e.detail or e.reason)
        return None, e.reason
    except ValueError as e:  # SSRF 拦截等在 members 合法性阶段抛出
        log.warning("下载失败 %s：%s", url[:80], e)
        return None, "unsafeUrl"
    except Exception as e:  # noqa: BLE001 —— 图片本身坏掉不该让建库整批中断
        log.warning("下载失败 %s：%s", url[:80], e)
        return None, "badImage"


def _decode_image(data: bytes) -> Image.Image:
    """解码图片，并**只保留识别需要的分辨率**。

    识别链路真正吃到的分辨率是：检测 640、ReID 224。手机原图 4000×3000 的 JPEG
    完整解码要 200~400ms，随后 engine 又把它缩到 640/224 —— 这段时间纯属浪费。
    JPEG 的 `draft()` 能让 libjpeg 直接按 1/2、1/4、1/8 解码（DCT 缩放），
    再用 thumbnail 兜底到最长边 FETCH_MAX_SIDE，CPU 和内存都显著下降。

    为什么是 1024：要留出「检测框裁出来仍够 224」的余量（猫在画面里可能只占一角）。
    再小会开始影响小目标检测；再大对精度无增益，只是多花解码时间。
    `draft` 对 PNG/WebP 无效（PIL 会忽略），仍然走后面的 thumbnail 兜底。
    """
    import io

    max_side = int(config.FETCH_MAX_SIDE or 0)
    # with 保证文件句柄关闭：convert 产生新图后原图 fp 不会泄漏
    # （Linux 下能删打开中的文件但 inode 不释放，反复调视频识别会累积）
    with Image.open(io.BytesIO(data)) as im:
        if max_side > 0 and (im.format or "").upper() == "JPEG":
            # draft 必须在 load 之前调用才生效；传入目标框即可，PIL 自行选缩放档位
            try:
                im.draft("RGB", (max_side, max_side))
            except Exception:  # noqa: BLE001 —— 某些 JPEG（如 CMYK）不支持 draft
                pass
        out = im.convert("RGB")
    if max_side > 0 and max(out.size) > max_side:
        out.thumbnail((max_side, max_side))
    return out


def decode_base64_image(data: str) -> Optional[Image.Image]:
    """解码云函数内联传来的图片字节（base64 或 data URL）。

    为什么需要：云函数做安全检测时本来就要把图下载到内存，再把同一份字节内联
    传给识别服务，服务端就不用再跨服务下载一次（现场日志：768px 缩略图下载 530ms，
    占整次识别 1.6s 的三分之一）。图片体积只有百 KB 级，base64 膨胀 33% 也可接受。

    解码失败/超限直接抛 ValueError，由调用方回退到链接下载 —— 内联只是快路径，
    不允许它成为唯一路径。
    """
    import base64 as _b64

    s = (data or "").strip()
    if not s:
        return None
    if s.startswith("data:"):
        s = s.partition(",")[2]
    s = "".join(s.split())  # base64 里可能夹换行
    try:
        raw = _b64.b64decode(s, validate=False)
    except Exception as e:  # noqa: BLE001
        raise ValueError("base64 解码失败") from e
    if len(raw) > config.MAX_IMAGE_BYTES:
        raise ValueError("内联图片超过 MAX_IMAGE_BYTES")
    return _decode_image(raw)


def fetch_image(url: str, timeout: Optional[float] = None) -> Optional[Image.Image]:
    """下载一张图。失败返回 None（调用方负责降级），不抛异常打断主流程。"""
    im, _ = fetch_image_ex(url, timeout=timeout)
    return im


# 已知支持 COS 图片处理（imageMogr2）的域名后缀。云开发云存储的临时链接
# 就长这样（xxx.tcb.qcloud.la / xxx.cos.ap-shanghai.myqcloud.com），
# 云函数侧也是用同一套参数拼缩略图的。
_COS_HOST_SUFFIXES = (".tcb.qcloud.la", ".myqcloud.com", ".qcloud.la")

# 识别只需要 768px 级别，超过这个尺寸的缩略参数没有意义
_MIN_THUMB_SIDE = 320


def _is_cos_host(url: str) -> bool:
    from urllib.parse import urlparse

    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return False
    return bool(host) and any(host.endswith(s) for s in _COS_HOST_SUFFIXES)


def _has_jpeg_format(url: str) -> bool:
    low = url.lower()
    return "/format/jpg" in low or "/format/jpeg" in low


def force_jpeg(url: str) -> str:
    """把云函数传来的缩略图 URL 改成 JPEG 传输。

    现场数据（2026-10-28 云托管日志）：小程序上传的是 .png，768px 缩略图下载
    耗了 902ms —— 照片类 PNG 压缩率极差，同分辨率 JPEG 通常只有它的 1/10。
    识别只读 RGB，不需要 alpha 通道，转码没有精度损失。

    非 COS 域名、或调用方自己指定了 format 的，原样返回（不冒险改第三方链接）。
    """
    if not config.THUMB_JPEG or not url or not _is_cos_host(url):
        return url
    if _has_jpeg_format(url):
        return url
    if "imageMogr2" in url:
        # 已有处理链（通常是 /thumbnail/768x），直接在末尾补格式转换
        return url + "/format/jpg"
    sep = "&" if "?" in url else "?"
    size = max(_MIN_THUMB_SIDE, int(config.DERIVE_THUMB_SIZE or 768))
    return f"{url}{sep}imageMogr2/thumbnail/{size}x/format/jpg"


def derive_thumb_url(url: str) -> str:
    """兜底生成缩略图 URL：调用方没给 thumbUrl 时用。

    为什么服务端也要会这一手：缩略图是「下载慢」的最大解药，而拼接动作原本
    只在云函数里做（vision.js）。只要云函数没跟着更新，服务端拿到的就永远是
    3~10MB 的原图链接 —— 服务升级了、耗时却一点没变，这种「改了看起来没生效」
    最难查。所以服务端自己再做一次：命中已知 CIS/COS 域名才拼，其它域名原样返回。

    拼坏了也只是多一次 400 下载（调用方会回退原图），不影响结果正确性。
    """
    if not config.DERIVE_THUMB or not url or not _is_cos_host(url):
        return ""
    if "imageMogr2" in url:
        # 已有处理参数就不再叠加第二段 imageMogr2
        return url if _has_jpeg_format(url) else url + "/format/jpg"
    sep = "&" if "?" in url else "?"
    size = max(_MIN_THUMB_SIDE, int(config.DERIVE_THUMB_SIZE or 768))
    return f"{url}{sep}imageMogr2/thumbnail/{size}x/format/jpg"


def io_bytes(b: bytes):
    import io

    return io.BytesIO(b)


def ffmpeg_ok() -> bool:
    return shutil.which(config.FFMPEG) is not None


def extract_frames(video_url: str, n: int) -> List[Image.Image]:
    """从视频里均匀抽 n 帧。

    用 -vf fps 抽帧而不是逐帧解码，避免长视频把内存撑爆；抽不到就返回空列表，
    调用方会退回封面帧路径。
    """
    if not ffmpeg_ok():
        log.warning("未找到 ffmpeg，无法抽帧")
        return []

    tmp = Path(tempfile.mkdtemp(prefix="catcampus_"))
    src = tmp / "v.bin"
    try:
        src.write_bytes(_download(video_url, config.MAX_VIDEO_BYTES))

        # 先问出视频时长，再按「总时长 / 目标帧数」定抽帧速率，保证均匀覆盖全片
        fps_cmd = [
            config.FFPROBE, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(src),
        ]
        try:
            dur = float(subprocess.run(
                fps_cmd, capture_output=True, text=True, timeout=15
            ).stdout.strip() or 0)
        except Exception:  # noqa: BLE001
            dur = 0.0

        rate = 1.0
        if dur > 0:
            rate = min(4.0, max(0.2, n / dur))  # 限制 0.2~4 fps，防止极端值

        out_dir = tmp / "f"
        out_dir.mkdir(exist_ok=True)
        cmd = [
            config.FFMPEG, "-hide_banner", "-loglevel", "error",
            "-i", str(src),
            "-vf", f"fps={rate:.3f}", "-vframes", str(max(1, n)),
            "-q:v", "3", str(out_dir / "f_%03d.jpg"),
        ]
        subprocess.run(cmd, timeout=config.FETCH_TIMEOUT * 4, check=False)

        imgs = []
        for p in sorted(out_dir.glob("f_*.jpg")):
            try:
                # with 关句柄：convert 后原图 fp 不泄漏（见 fetch_image 注释）
                with Image.open(p) as im:
                    imgs.append(im.convert("RGB"))
            except Exception:  # noqa: BLE001
                continue
        return imgs
    except Exception as e:  # noqa: BLE001
        log.warning("抽帧失败：%s", e)
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
