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


def _download(url: str, max_bytes: int) -> bytes:
    """带大小上限的下载。历史上 r.content 一次性全量入内存，
    一个几百 MB 的 URL 就能打爆容器内存限额。"""
    _assert_safe_url(url)
    try:
        with _http().stream("GET", url) as r:
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


def fetch_image_ex(url: str):
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
        data = _download(url, config.MAX_IMAGE_BYTES)
        # with 保证文件句柄关闭：convert 产生新图后原图 fp 不会泄漏
        # （Linux 下能删打开中的文件但 inode 不释放，反复调视频识别会累积）
        import io

        with Image.open(io.BytesIO(data)) as im:
            return im.convert("RGB"), ""
    except DownloadError as e:
        log.warning("下载失败 %s：%s", url[:80], e.detail or e.reason)
        return None, e.reason
    except ValueError as e:  # SSRF 拦截等在 members 合法性阶段抛出
        log.warning("下载失败 %s：%s", url[:80], e)
        return None, "unsafeUrl"
    except Exception as e:  # noqa: BLE001 —— 图片本身坏掉不该让建库整批中断
        log.warning("下载失败 %s：%s", url[:80], e)
        return None, "badImage"


def fetch_image(url: str) -> Optional[Image.Image]:
    """下载一张图。失败返回 None（调用方负责降级），不抛异常打断主流程。"""
    im, _ = fetch_image_ex(url)
    return im


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
