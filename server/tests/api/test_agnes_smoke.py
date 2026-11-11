"""agnes 接口冒烟测试（无需 pytest，直接 python test_agnes_smoke.py）。

- key 未配置时只验证「封装接通 + 503 兜底」；
- 填好 AGNES_API_KEY（server/.env 或环境变量）后重跑，会真实打到 agnes 接口，
  测试纯文本对话 + 文本/图片多模态两种调用。
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

import app.config as cfg
from app import agnes


def _banner(t: str):
    print("\n" + "=" * 56)
    print(t)
    print("=" * 56)


def main():
    _banner("配置检查")
    print("AGNES_API_BASE =", cfg.AGNES_API_BASE)
    print("AGNES_MODEL    =", cfg.AGNES_MODEL)
    print("endpoint       =", agnes._endpoint())
    has_key = bool(cfg.AGNES_API_KEY)
    print("AGNES_API_KEY  =", ("已配置(%d字符)" % len(cfg.AGNES_API_KEY)) if has_key else "空（未配置）")

    if not has_key:
        _banner("未配置 KEY → 验证 503 兜底（不发包）")
        try:
            agnes.agnes_chat_text("你好")
            print("✗ 异常：没抛 AgnesError")
        except agnes.AgnesError as e:
            print("✓ 兜底生效 -> status=%s | %s" % (e.status, e.message))
        print("\n请在 server/.env 的 AGNES_API_KEY= 后面填入你的 key，然后重跑本脚本。")
        return

    # ---- 以下为真实调用 ----
    _banner("测试1 · 纯文本对话")
    try:
        ans = agnes.agnes_chat_text(
            "用一句话介绍你自己是什么模型。",
            system="你是一个简洁的助手，回答不超过 30 字。",
        )
        print("✓ 回复：", ans)
    except agnes.AgnesError as e:
        print("✗ 失败 -> status=%s | %s" % (e.status, e.message))

    _banner("测试2 · 多模态（本地生成图 + base64，自动嗅探 mime）")
    # 本地生成一张测试图转 base64，避免依赖 agnes 服务端拉外链（外链常超时）。
    try:
        from PIL import Image
        import io as _io, base64 as _b64

        _img = Image.new("RGB", (320, 240), (240, 180, 90))
        _buf = _io.BytesIO()
        _img.save(_buf, format="PNG")
        _b64img = _b64.b64encode(_buf.getvalue()).decode()
        ans = agnes.agnes_chat_with_image(
            "这张图的主色调是什么？用一句话回答。",
            image_b64=_b64img,
        )
        print("✓ 回复：", ans)
    except agnes.AgnesError as e:
        print("✗ 失败 -> status=%s | %s" % (e.status, e.message))

    print("\n全部测试结束。")


if __name__ == "__main__":
    main()
