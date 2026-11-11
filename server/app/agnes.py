"""封装对 agnes 大模型（兼容 OpenAI Chat Completions 格式）的调用。

agnes 的端点兼容标准 OpenAI /chat/completions 协议：
    完整 URL = AGNES_API_BASE + "/chat/completions"
因此它吃标准的 messages（role / content），并支持多模态（content 为
image_url + text 的 parts 数组）。

配置（环境变量，见 .env.example，key 由部署方填写）：
    AGNES_API_BASE  https://api.agnes-ai.cn/v1   自定义请求地址（不要结尾斜杠）
    AGNES_API_KEY   （必填，留空则接口返回「未配置」错误，不把空 key 发给远端）
    AGNES_MODEL     agnes-2.5-flash               模型 ID
    AGNES_TIMEOUT   30                            单次请求超时（秒）

提供三层封装：
    agnes_request(...)       底层：返回 agnes 原始响应 JSON（choices / usage）
    agnes_chat(...)          高层：传 messages，返回助手回复纯文本
    agnes_chat_text(...)     便捷：纯文本对话（可带 system）
    agnes_chat_with_image(...) 便捷：文本 + 一张图片（URL 或 base64）

所有异常统一为 AgnesError（含 status 字段），不会让调用方炸栈。
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any, Dict, List, Optional

import httpx

from . import config

log = logging.getLogger("agnes")


class AgnesError(Exception):
    """agnes 调用失败：网络错误 / 鉴权缺失 / 远端返回非 200。"""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.message = message
        self.status = status


# ----------------------------------------------------------------------------
# 内部工具
# ----------------------------------------------------------------------------

def _endpoint() -> str:
    base = (config.AGNES_API_BASE or "https://api.agnes-ai.cn/v1").rstrip("/")
    return base + "/chat/completions"


def _headers() -> Dict[str, str]:
    headers = {"Content-Type": "application/json"}
    key = config.AGNES_API_KEY
    if key:
        headers["Authorization"] = "Bearer " + key
    return headers


# ----------------------------------------------------------------------------
# 底层请求
# ----------------------------------------------------------------------------

def agnes_request(
    messages: List[Dict[str, Any]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    top_p: Optional[float] = None,
    json_mode: bool = False,
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """底层请求，返回 agnes 原始响应 JSON（OpenAI 的 choices / usage 结构）。

    调用前若未配置 AGNES_API_KEY，直接抛 AgnesError(status=503)，
    不把空 key 发给远端。
    """
    if not config.AGNES_API_KEY:
        raise AgnesError(
            "agnes 未配置 API Key（请设置环境变量 AGNES_API_KEY）", status=503
        )

    payload: Dict[str, Any] = {
        "model": model or config.AGNES_MODEL or "agnes-2.5-flash",
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if top_p is not None:
        payload["top_p"] = top_p
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    try:
        with httpx.Client(
            timeout=timeout or config.AGNES_TIMEOUT or 30, follow_redirects=True
        ) as client:
            r = client.post(_endpoint(), json=payload, headers=_headers())
    except httpx.TimeoutException as e:
        raise AgnesError(f"agnes 请求超时：{e}", status=408)
    except httpx.HTTPError as e:
        raise AgnesError(f"agnes 网络错误：{e}", status=0)

    if r.status_code != 200:
        detail = ""
        try:
            detail = (r.json().get("error", {}) or {}).get("message") or r.text
        except Exception:
            detail = r.text
        raise AgnesError(
            f"agnes 返回 {r.status_code}: {detail[:300]}", status=r.status_code
        )

    try:
        return r.json()
    except Exception as e:  # noqa: BLE001 —— 远端可能返回非 JSON 体
        raise AgnesError(f"agnes 响应不是合法 JSON：{e}", status=0)


# ----------------------------------------------------------------------------
# 高层封装
# ----------------------------------------------------------------------------

def agnes_chat(
    messages: List[Dict[str, Any]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    json_mode: bool = False,
    timeout: Optional[float] = None,
) -> str:
    """传 messages，返回助手回复的纯文本。"""
    data = agnes_request(
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        json_mode=json_mode,
        timeout=timeout,
    )
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise AgnesError(
            f"agnes 响应结构异常：{e} | {json.dumps(data, ensure_ascii=False)[:300]}",
            status=0,
        )


# ----------------------------------------------------------------------------
# 便捷封装
# ----------------------------------------------------------------------------

def text_message(role: str, text: str) -> Dict[str, Any]:
    """构造一条纯文本消息。"""
    return {"role": role, "content": text}


def agnes_chat_text(
    prompt: str,
    *,
    system: Optional[str] = None,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
    json_mode: bool = False,
) -> str:
    """纯文本对话。可选带 system 提示。"""
    messages: List[Dict[str, Any]] = []
    if system:
        messages.append(text_message("system", system))
    messages.append(text_message("user", prompt))
    return agnes_chat(
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        json_mode=json_mode,
    )


def _sniff_mime(raw: bytes) -> str:
    """按文件魔数识别常见图片类型；认不出一律按 jpeg 处理。"""
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:4] == b"GIF8":
        return "image/gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def image_content(
    url: Optional[str] = None,
    b64: Optional[str] = None,
    media_type: Optional[str] = None,
) -> Dict[str, Any]:
    """构造一个 image_url content part。图片可传 URL 或 base64。

    base64 模式若没传 media_type，会按文件魔数自动嗅探（png/jpeg/webp/gif），
    避免「声明 jpeg 实为 png」这类被服务端拒的坑。
    """
    if b64:
        if media_type is None:
            try:
                media_type = _sniff_mime(base64.b64decode(b64))
            except Exception:
                media_type = "image/jpeg"
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{media_type};base64,{b64}"},
        }
    if url:
        return {"type": "image_url", "image_url": {"url": url}}
    raise ValueError("image_content 必须提供 url 或 b64")


def agnes_chat_with_image(
    prompt: str,
    *,
    image_url: Optional[str] = None,
    image_b64: Optional[str] = None,
    system: Optional[str] = None,
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
) -> str:
    """多模态：文本 + 一张图片。图片可传 URL 或 base64（自动拼 data URI）。

    注意：content 里用的是 OpenAI 的「part」格式（type/text、type/image_url），
    不能用 text_message（那是顶层消息的 role/content 格式）。
    """
    if not image_url and not image_b64:
        raise ValueError("agnes_chat_with_image 必须提供 image_url 或 image_b64")
    content: List[Dict[str, Any]] = [
        image_content(url=image_url, b64=image_b64),
        {"type": "text", "text": prompt},
    ]
    messages: List[Dict[str, Any]] = []
    if system:
        messages.append(text_message("system", system))
    messages.append({"role": "user", "content": content})
    return agnes_chat(
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
    )
