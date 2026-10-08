"""素材获取：下载图片、用 ffmpeg 抽视频帧。

ffmpeg 是自建服务相对云函数的最大优势 —— 微信云函数的 Node 运行环境里没有 ffmpeg，
视频只能拿封面帧凑合；自建服务器上可以任意装系统包，真抽帧才走得通。
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional

import httpx
from PIL import Image

from . import config

log = logging.getLogger("catcampus.media")

_client: Optional[httpx.Client] = None


def _http() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=config.FETCH_TIMEOUT, follow_redirects=True)
    return _client


def fetch_image(url: str) -> Optional[Image.Image]:
    """下载一张图。失败返回 None（调用方负责降级），不抛异常打断主流程。"""
    if not url:
        return None
    try:
        r = _http().get(url)
        r.raise_for_status()
        im = Image.open(io_bytes(r.content))
        im.load()
        return im.convert("RGB")
    except Exception as e:  # noqa: BLE001
        log.warning("下载失败 %s：%s", url[:80], e)
        return None


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
        r = _http().get(video_url)
        r.raise_for_status()
        src.write_bytes(r.content)

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
                im = Image.open(p)
                im.load()
                imgs.append(im.convert("RGB"))
            except Exception:  # noqa: BLE001
                continue
        return imgs
    except Exception as e:  # noqa: BLE001
        log.warning("抽帧失败：%s", e)
        return []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
