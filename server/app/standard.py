# -*- coding: utf-8 -*-
"""猫咪「标准照」生成（AIGC 文生图）。

输入一张猫照片，输出两张标准写真（命名沿用线下素材约定）：
    · xx1.png —— 全身站姿照（默认 2048x1536，4:3 横版）
    · xx2.png —— 正面标准照（默认 2048x2048，方图）

链路：属性分析（检测 + 抠图 + 花色启发式）→ 两组中文提示词 → 图片生成 → PNG bytes。

生成后端按配置自动选择：
  · **AGNES 图片模型（默认）**：POST /images/generations，请求体里带 `image` 字段
    （原图的 data URI）时服务端走 i2i 队列，生成的画面锁定「参考照片里这只猫」的
    毛色、花纹、眼色、脸型与体型 —— 不是同品种的陌生猫。仅提示词（t2i）做不到这一点。
  · **IMAGE_GEN_URL 模板**：仅能传提示词，用于接其它服务商；显式配置时优先。

⚠️ **不做本地拼图兜底**：标准照的价值是「AI 重新画出标准姿态」，用抠图 + 换背景
做出来的只是同一张照片的裁切，却会被当成生成结果。两种后端都未配置时接口返回
503，让部署方明确去配，而不是悄悄降级成假图（见 config 同名开关注释）。
"""
from __future__ import annotations

import base64
import io
import logging
import re
from pathlib import Path
from typing import Dict, List, Tuple
from urllib.parse import quote, urlencode

import httpx
from PIL import Image

from . import attrs as attr_heuristic
from . import config, media

log = logging.getLogger("catcampus.standard")

DEFAULT_STYLE = "写实高清摄影"

# 常见 AI 绘画瑕疵的负向约束。部分服务商不支持 negative prompt，所以直接写进
# 正向提示词里；放在两组提示词末尾，不影响主体描述。
ANTI_ARTIFACTS = (
    "严格避免AI绘画瑕疵：肢体错乱、五官崩坏、多余肢体、多指/多趾、"
    "畸形耳朵、眼睛不对称、尾巴断裂。"
)

# 走 i2i（带参考图）时插在提示词开头。i2i 队列对"保持原图主体"的遵从度明显高于
# 纯文本，但仍需要一句明确约束，否则模型容易把猫画成同品种的另一只。
REFERENCE_NOTE = (
    "以参考照片中的同一只猫为主体，严格保持它的毛色分布、花纹位置、"
    "眼睛颜色、脸型与体型，不要换成另一只猫；"
)

FRONT_TEMPLATE = (
    "{style}，{ref}一只{animal}的正面标准证件照。正向面对镜头，端坐，头和胸部完整入镜，"
    "对焦面部，双眼清晰有神，五官比例正常且左右对称，双耳直立无畸形，鼻头与胡须自然；"
    "纯色简洁浅灰背景，柔和均匀的影棚布光，无杂物，证件肖像质感。"
    "{anti}{extra}"
)

FULL_TEMPLATE = (
    "{style}，{ref}一只{animal}的全身站姿照。自然站立，四脚着地，身体舒展，尾巴自然下垂，"
    "完整全身入镜，四爪与尾尖不被裁切，体态正常；浅灰纯色影棚背景，干净地面，"
    "柔和均匀的布光，整体风格与{style}一致。{anti}{extra}"
)

# 两张图的业务标识。顺序即返回顺序：先全身（xx1），后正面（xx2）。
KIND_FULL = "fullBody"
KIND_FRONT = "front"
LABELS = {KIND_FULL: "全身站姿照", KIND_FRONT: "正面标准照"}


class GenerationError(Exception):
    """生图失败：远端非 200 / 返回非图片 / 结果落盘失败。"""


class ProviderNotConfigured(GenerationError):
    """未配置任何图片生成服务（IMAGE_GEN_URL 与 AGNES_API_KEY 都为空）。"""


# ---------------- 提示词 ----------------
def build_prompts(animal: str, style: str = "", extra: str = "",
                  with_ref: bool = False) -> Dict[str, str]:
    """按技能说明固定输出两组提示词。

    animal  ：动物名称/花色（三花猫、玄猫、奶牛猫…）。为空时用「猫」，
              保证远端永远能拿到一个可生成的主语。
    style   ：画面风格，默认写实高清摄影。
    extra   ：额外要求（背景/光影/画质等），可选。
    with_ref：是否附带「保持参考照片中这只猫」的约束（走 i2i 时为 True）。
    """
    animal = (animal or "").strip() or "猫"
    style = (style or "").strip() or DEFAULT_STYLE
    extra_text = ""
    if (extra or "").strip():
        extra_text = "额外要求：%s。" % extra.strip()
    ctx = {"animal": animal, "style": style, "anti": ANTI_ARTIFACTS,
           "extra": extra_text, "ref": REFERENCE_NOTE if with_ref else ""}
    return {"front": FRONT_TEMPLATE.format(**ctx),
            "fullBody": FULL_TEMPLATE.format(**ctx)}


def _auto_animal(im: Image.Image) -> Tuple[str, bool, dict]:
    """从照片自动推断「什么猫」：品种名优先，其次毛色中文。

    属性分析失败绝不阻断生成 —— 用户要的是图，最差也能生成一只「猫」。
    """
    try:
        from .engine import get_engine
        _, detected, attr = get_engine().features_ex(im)
        name = (attr.get("breed") or "").strip()
        if not name:
            label = attr_heuristic.COLOR_LABELS.get((attr.get("color") or "").strip(), "")
            if label:
                name = label + "猫"
        return name or "猫", bool(detected), attr
    except Exception as e:  # noqa: BLE001 —— 见 docstring
        log.warning("标准照属性分析失败，按「猫」生成：%s: %s", type(e).__name__, e)
        return "猫", False, {}


# ---------------- 图片生成服务 ----------------
# 参考图长边上限。agnes 的 i2i 队列吃 data URI，但请求体越大越慢；1024 已足够
# 让模型看清毛色/花纹/眼色/脸型，且单张 JPEG 只有一两百 KB。
REF_MAX_SIDE = 1024


def _reference_data_uri(im: Image.Image) -> str:
    """把原图压成「长边 ≤1024 的 JPEG data URI」，作为 i2i 的参考图。"""
    ref = im.convert("RGB")
    if max(ref.size) > REF_MAX_SIDE:
        ref = ref.copy()
        ref.thumbnail((REF_MAX_SIDE, REF_MAX_SIDE))
    buf = io.BytesIO()
    ref.save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _agnes_image_call(prompt: str, image_size: str, ref_uri: str = "") -> bytes:
    """调 agnes 图片模型（OpenAI 兼容 /images/generations），返回图片字节。

    **ref_uri 非空时服务端走 i2i 队列**（实测返回的 URL 路径为 /images/i2i/…），
    生成的猫与参考图保持同一外观；留空则是普通文生图（t2i）。

    size 只接受 "1K/2K/3K/4K" 或 "WIDTHxHEIGHT"，像 landscape_4_3 / square_hd
    这类命名会被 400 拒绝 —— 所以 config 里的默认值改成了像素尺寸。
    """
    if not config.AGNES_API_KEY:
        raise ProviderNotConfigured(
            "未配置图片生成服务：请设置 IMAGE_GEN_URL，或配置 AGNES_API_KEY + "
            "IMAGE_GEN_MODEL（agnes 图片模型，支持带参考图生成，详见 server/.env.example）")

    base = (config.AGNES_API_BASE or "https://api.agnes-ai.cn/v1").rstrip("/")
    payload = {
        "model": config.IMAGE_GEN_MODEL or "agnes-image-2.1-flash",
        "prompt": prompt,
        "n": 1,
        "size": image_size,
    }
    if ref_uri:
        payload["image"] = ref_uri
    headers = {"Authorization": "Bearer " + config.AGNES_API_KEY,
               "Content-Type": "application/json"}

    try:
        r = httpx.post(base + "/images/generations", json=payload, headers=headers,
                       timeout=config.IMAGE_GEN_TIMEOUT)
    except httpx.TimeoutException as e:
        raise GenerationError("生图服务超时（%ss）：%s" % (config.IMAGE_GEN_TIMEOUT, e))
    except httpx.HTTPError as e:
        raise GenerationError("生图服务请求失败：%s" % e)

    if r.status_code != 200:
        msg = ""
        try:
            msg = ((r.json() or {}).get("error") or {}).get("message") or ""
        except Exception:  # noqa: BLE001 —— 远端可能返回非 JSON
            msg = (r.text or "")[:200]
        raise GenerationError("生图服务返回 HTTP %d：%s" % (r.status_code, msg[:300]))

    try:
        body = r.json()
    except Exception:  # noqa: BLE001
        raise GenerationError("生图服务返回了非 JSON 内容")
    return _bytes_from_payload(body)


def _provider_call(prompt: str, image_size: str, ref_uri: str = "") -> bytes:
    """调用一次图片生成服务，返回原始图片字节。

    优先 IMAGE_GEN_URL（GET 模板，仅提示词）；未配置时走 agnes 图片模型，
    并在有参考图时使用 i2i —— 这样默认行为就是「基于原图生成同一只猫」。
    IMAGE_GEN_URL 支持 {prompt} / {image_size} 两个占位符；不含占位符时
    自动追加 ?prompt=...&image_size=...，方便接简单的 GET 接口。
    """
    base = (config.IMAGE_GEN_URL or "").strip()
    if not base:
        return _agnes_image_call(prompt, image_size, ref_uri)

    if "{prompt}" in base or "{image_size}" in base:
        url = base.replace("{prompt}", quote(prompt, safe=""))
        url = url.replace("{image_size}", quote(image_size, safe=""))
    else:
        qs = urlencode({"prompt": prompt, "image_size": image_size})
        url = base + ("&" if "?" in base else "?") + qs

    headers = {"Accept": "image/*, application/json"}
    token = (config.IMAGE_GEN_TOKEN or "").strip()
    if token:
        headers["Authorization"] = "Bearer " + token

    try:
        r = httpx.get(url, headers=headers, timeout=config.IMAGE_GEN_TIMEOUT)
    except httpx.TimeoutException as e:
        raise GenerationError("生图服务超时（%ss）：%s" % (config.IMAGE_GEN_TIMEOUT, e))
    except httpx.HTTPError as e:
        raise GenerationError("生图服务请求失败：%s" % e)

    if r.status_code != 200:
        raise GenerationError("生图服务返回 HTTP %d：%s"
                              % (r.status_code, (r.text or "")[:200]))

    ctype = (r.headers.get("content-type") or "").lower()
    if ctype.startswith("image/"):
        return r.content
    try:
        payload = r.json()
    except Exception:  # noqa: BLE001 —— 远端可能返回 HTML / 纯文本
        raise GenerationError("生图服务返回了非图片内容（content-type=%s）" % ctype)
    return _bytes_from_payload(payload)


# JSON 响应里常见的图片字段。不同服务商命名差异很大，统一递归找一遍。
_B64_KEYS = {"b64_json", "base64", "b64", "image_base64", "img_base64", "image"}
_URL_KEYS = {"url", "image_url", "img_url"}


def _walk_image_fields(node, depth: int = 0):
    """递归产出 (类型, 值)：类型是 b64 / url。"""
    if depth > 6:
        return
    if isinstance(node, dict):
        for k, v in node.items():
            key = str(k).lower()
            if isinstance(v, str) and v:
                if key in _B64_KEYS:
                    yield ("url", v) if v.startswith("http") else ("b64", v)
                elif key in _URL_KEYS:
                    yield ("url", v)
            elif isinstance(v, (dict, list)):
                yield from _walk_image_fields(v, depth + 1)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_image_fields(item, depth + 1)


def _decode_b64(text: str) -> bytes:
    s = (text or "").strip()
    if s.startswith("data:"):
        s = s.partition(",")[2]
    s = "".join(s.split())
    return base64.b64decode(s, validate=False)


def _bytes_from_payload(payload) -> bytes:
    """从远端 JSON 里取图片：支持 b64_json / url / data URL 等常见形态。"""
    for kind, value in _walk_image_fields(payload):
        try:
            if kind == "b64":
                return _decode_b64(value)
            return media.download_bytes(value, int(config.IMAGE_GEN_MAX_BYTES),
                                        timeout=config.IMAGE_GEN_TIMEOUT)
        except Exception as e:  # noqa: BLE001 —— 换下一个候选字段
            log.warning("生图结果字段不可用（%s）：%s", kind, e)
    msg = ""
    if isinstance(payload, dict):
        msg = str(payload.get("message") or payload.get("error")
                  or payload.get("msg") or "")[:200]
    raise GenerationError("生图服务返回中没有可识别的图片字段"
                          + ("：" + msg if msg else ""))


def _ensure_png(raw: bytes) -> bytes:
    """把远端返回的任意图片格式统一成 PNG（也顺手验证数据有效性）。"""
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
        im = im.convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise GenerationError("生图服务返回的数据不是有效图片：%s" % e)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


# ---------------- 主流程 ----------------
def _safe_name(name: str, fallback: str) -> str:
    """输出文件名前缀：去掉路径分隔符/控制字符，保留中文。"""
    base = (name or "").strip() or (fallback or "").strip() or "cat"
    base = re.sub(r'[\\/:*?"<>|\r\n\t ]', "", base)
    base = base[:32].strip()
    return base or "cat"


def _save_png(filename: str, png: bytes) -> str:
    directory = Path(config.IMAGE_GEN_DIR)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / filename
    path.write_bytes(png)
    return str(path)


def generate_standard(im: Image.Image, animal: str = "", style: str = "",
                      extra: str = "", name: str = "", save: bool = False) -> dict:
    """生成两张标准照。返回的 images 里每项带 PNG bytes（由路由层转 base64）。

    animal 传了就直接用（不再跑属性分析，省一次模型推理）；否则自动识别。
    """
    if (animal or "").strip():
        animal_text, detected, attr = animal.strip(), False, {}
        animal_source = "request"
    else:
        animal_text, detected, attr = _auto_animal(im)
        animal_source = "auto"

    prompts = build_prompts(animal_text, style, extra)
    prefix = _safe_name(name, animal_text)

    # 默认走 agnes i2i：把原图作为参考图发过去，生成的才是「这只猫」。
    # IMAGE_GEN_URL 模板只能带提示词，显式配置时按用户意图优先。
    use_ref = not (config.IMAGE_GEN_URL or "").strip() and bool(config.AGNES_API_KEY)
    ref_uri = _reference_data_uri(im) if use_ref else ""
    if ref_uri:
        prompts = build_prompts(animal_text, style, extra, with_ref=True)

    # 顺序固定：xx1 = 全身站姿照，xx2 = 正面标准照（与线下标准照素材一致）。
    specs = [
        (KIND_FULL, prompts["fullBody"], config.IMAGE_GEN_SIZE_FULL, 1),
        (KIND_FRONT, prompts["front"], config.IMAGE_GEN_SIZE_FRONT, 2),
    ]
    images: List[dict] = []
    for kind, prompt, size, idx in specs:
        raw = _provider_call(prompt, size, ref_uri)
        png = _ensure_png(raw)
        images.append({
            "kind": kind,
            "label": LABELS[kind],
            "filename": "%s%d.png" % (prefix, idx),
            "imageSize": size,
            "prompt": prompt,
            "png": png,
        })
        log.info("标准照生成 %s size=%s %dKB", kind, size, len(png) // 1024)

    if save:
        if not (config.IMAGE_GEN_DIR or "").strip():
            raise GenerationError("请求 save=true，但未配置 IMAGE_GEN_DIR（结果落盘目录）")
        for item in images:
            item["path"] = _save_png(item["filename"], item["png"])

    return {
        "animal": animal_text,
        "animalSource": animal_source,
        "detected": detected,
        "attr": {k: attr.get(k) for k in
                 ("color", "pattern", "breed", "confidence", "source", "reason")},
        # provider=agnes 表示带参考图（i2i），生成结果与输入照片是同一只猫
        "provider": "agnes" if use_ref else "url",
        "reference": bool(ref_uri),
        "images": images,
    }
