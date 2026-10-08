# -*- coding: utf-8 -*-
"""
真实模型 + 真实猫照片的端到端验收。

区别于 tools/smoke_test.py（占位引擎 + 合成图）：
  - 要求 provider == onnx（必须是 DINOv2 真模型）
  - 素材用 HF 官方的四格真实猫照片 + 旋转/模糊/裁切等真实拍摄条件变化
  - 校验「同猫高分、异猫低分、无关图接近 0 分」这三条区分度

前置：
  1) 已下载权重：models/reid.onnx（86.8 MB，tools/fetch_model.py）
  2) 已起服务：..\\env\\Scripts\\python -m uvicorn app.main:app --host 127.0.0.1 --port 8090
运行：
  ..\\env\\Scripts\\python tools\\real_test.py
"""
from __future__ import annotations

import io
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

BASE = os.getenv("AI_BASE", "http://127.0.0.1:8090")
TOKEN = os.getenv("AI_TOKEN", "catcampus-local-dev-token")
PORT = 8099
FFMPEG = os.getenv(
    "FFMPEG",
    r"E:\Agent\project\opc-tools\video-service\ffmpeg\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe",
)

PASS = FAIL = 0
ASSETS: dict[str, bytes] = {}


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}   {detail}")


def load_real_cats() -> bool:
    """下载 HF 官方示例里的四格真实猫照片，拆成 4 只个体。"""
    p = ROOT / "data" / "_cats.jpeg"
    if not p.exists():
        try:
            u = ("https://hf-mirror.com/datasets/huggingface/documentation-images"
                 "/resolve/main/cats.jpeg")
            p.parent.mkdir(exist_ok=True)
            p.write_bytes(urllib.request.urlopen(
                urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}),
                timeout=60).read())
        except Exception as e:
            print(f"真猫素材下载失败：{e}")
            return False

    grid = Image.open(p).convert("RGB")
    W, H = grid.size
    hw, hh = W // 2, H // 2
    for k, box in {
        "c1": (0, 0, hw, hh),
        "c2": (hw, 0, W, hh),
        "c3": (0, hh, hw, H),
        "c4": (hw, hh, W, H),
    }.items():
        buf = io.BytesIO()
        grid.crop(box).save(buf, "JPEG", quality=92)
        ASSETS[k] = buf.getvalue()
    return True


def make_variants() -> None:
    base = Image.open(io.BytesIO(ASSETS["c1"]))
    # 模拟“同一只猫，换个手机拍”：旋转 + 亮度 + 轻微糊 + 中心裁切
    q = base.rotate(-9, resample=Image.BICUBIC)
    q = ImageEnhance.Brightness(q).enhance(1.15)
    q = q.filter(ImageFilter.GaussianBlur(0.9))
    q = q.crop((int(q.width * .08), int(q.height * .08),
                int(q.width * .92), int(q.height * .92))).resize(base.size)
    buf = io.BytesIO()
    q.save(buf, "JPEG", quality=85)
    ASSETS["q_c1"] = buf.getvalue()

    b3 = Image.open(io.BytesIO(ASSETS["c3"]))
    q3 = ImageEnhance.Brightness(b3.transpose(Image.FLIP_LEFT_RIGHT)).enhance(0.88)
    q3 = q3.filter(ImageFilter.GaussianBlur(0.7))
    buf = io.BytesIO()
    q3.save(buf, "JPEG", quality=85)
    ASSETS["q_c3"] = buf.getvalue()

    # 无关对照：纯几何条纹
    stripe = Image.new("RGB", (512, 512), (255, 255, 255))
    d = ImageDraw.Draw(stripe)
    for i in range(0, 512, 32):
        d.rectangle([i, 0, i + 16, 512], fill=(30, 90, 160))
    buf = io.BytesIO()
    stripe.save(buf, "JPEG", quality=90)
    ASSETS["stripe"] = buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        key = self.path.lstrip("/").split("?")[0]
        data = ASSETS.get(key)
        if not data:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


def start_static():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.3)
    return srv


def main() -> int:
    print("=== 真实模型 × 真实猫照片 端到端验收 ===")
    print(f"目标服务: {BASE}\n")

    try:
        h = httpx.get(f"{BASE}/health", timeout=10).json()
    except Exception as e:
        print(f"服务未启动：{e}")
        print("先执行： ..\\env\\Scripts\\python -m uvicorn app.main:app --host 127.0.0.1 --port 8090")
        return 1

    check("服务已就绪", h.get("ok") is True, str(h))
    check("ReID 引擎为 ONNX 真模型", h.get("provider") == "onnx", f"provider={h.get('provider')}")
    check("特征维度 768", h.get("dim") == 768, f"dim={h.get('dim')}")
    check("ffmpeg 可用", h.get("ffmpeg") is True)
    if h.get("provider") != "onnx":
        print("\n未加载真实模型，后续用例跳过。")
        return 1

    if not load_real_cats():
        print("\n缺少真实猫素材，无法继续。")
        return 1
    make_variants()
    start_static()
    url = lambda k: f"http://127.0.0.1:{PORT}/{k}"  # noqa: E731
    hd = {"Authorization": f"Bearer {TOKEN}"}
    school = "real-test"

    # 库里放 3 只外观差异明显的：c1 / c3 / c4
    cats = [
        {"id": "c1", "name": "橘座", "photos": [url("c1")]},
        {"id": "c3", "name": "奶牛", "photos": [url("c3")]},
        {"id": "c4", "name": "三花", "photos": [url("c4")]},
    ]

    print("\n--- 1. 建特征库（3 只真猫）---")
    t0 = time.time()
    r = httpx.post(f"{BASE}/v1/index/build", json={"schoolId": school, "cats": cats},
                   headers=hd, timeout=180)
    check("建库成功", r.status_code == 200 and r.json().get("built") == 3, r.text[:200])
    print(f"      耗时 {int((time.time() - t0) * 1000)} ms")

    def recog(u, **kw):
        body = {"url": u, "type": "image", "frames": 1,
                "schoolId": school, "school_id": school, "cats": cats}
        body.update(kw)
        return httpx.post(f"{BASE}/v1/recognize", headers=hd, json=body, timeout=180).json()

    print("\n--- 2. 同一只猫换个角度拍（应命中且高分）---")
    b = recog(url("q_c1"))
    cands = b.get("candidates", [])
    top = cands[0] if cands else {}
    print("      " + str({c["catId"]: (c["score"], c.get("rawSim")) for c in cands}))
    print(f"      延迟 {b.get('meta', {}).get('latency')} ms")
    check("Top1 命中橘座", top.get("catId") == "c1", str(top))
    check("Top1 分数 >= 85", top.get("score", 0) >= 85, f"score={top.get('score')} sim={top.get('rawSim')}")
    if len(cands) > 1:
        gap_s = top["score"] - cands[1]["score"]
        print(f"      与次名分差 {gap_s} 分")
        check("与次名拉开 >= 10 分", gap_s >= 10, f"gap={gap_s}")

    print("\n--- 3. 另一只猫（不应被认成橘座）---")
    b3 = recog(url("q_c3"))
    t3 = (b3.get("candidates") or [{}])[0]
    print("      " + str({c["catId"]: (c["score"], c.get("rawSim")) for c in b3.get("candidates", [])}))
    check("Top1 命中奶牛", t3.get("catId") == "c3", str(t3))
    check("分数 >= 70", t3.get("score", 0) >= 70, f"score={t3.get('score')}")

    print("\n--- 4. 完全无关的图片（应接近 0 分）---")
    bs = recog(url("stripe"))
    ts = (bs.get("candidates") or [{}])[0]
    print("      " + str({c["catId"]: (c["score"], c.get("rawSim")) for c in bs.get("candidates", [])}))
    check("无关图 <= 15 分", ts.get("score", 99) <= 15, f"score={ts.get('score')} sim={ts.get('rawSim')}")

    print("\n--- 5. 返回向量 ---")
    check("768 维向量", len(b.get("features", {}).get("embedding", [])) == 768,
          str(len(b.get("features", {}).get("embedding", []))))

    print("\n--- 6. 视频抽帧识别（真实 ffmpeg）---")
    try:
        v = ROOT / "data" / "_rt.mp4"
        src = ROOT / "data" / "_rt_src.jpg"
        src.write_bytes(ASSETS["c1"])
        subprocess.run([FFMPEG, "-y", "-loop", "1", "-i", str(src), "-t", "3",
                        "-r", "25", "-pix_fmt", "yuv420p", str(v)],
                       capture_output=True, timeout=90, check=False)
        if v.exists():
            ASSETS["_rt.mp4"] = v.read_bytes()
            bv = httpx.post(f"{BASE}/v1/recognize", headers=hd, timeout=240, json={
                "url": url("c1"), "videoUrl": url("_rt.mp4"), "type": "video",
                "frames": 4, "schoolId": school, "school_id": school, "cats": cats,
            }).json()
            fr = bv.get("meta", {}).get("frames", 0)
            tv = (bv.get("candidates") or [{}])[0]
            print(f"      抽帧 {fr} 张，延迟 {bv.get('meta', {}).get('latency')} ms，Top1={tv.get('catId')} {tv.get('score')}")
            check("抽帧 > 1", fr > 1, f"frames={fr}")
            check("视频识别命中橘座", tv.get("catId") == "c1", str(tv))
        else:
            print("      [跳过] ffmpeg 未生成测试视频")
    except Exception as e:
        print(f"      [跳过] 视频用例异常：{e}")

    print("\n--- 7. 鉴权 ---")
    r = httpx.post(f"{BASE}/v1/recognize", timeout=30,
                   json={"url": url("c1"), "cats": cats, "schoolId": school})
    check("无 token 被拒", r.status_code in (401, 403), str(r.status_code))

    print(f"\n=== PASS {PASS} / FAIL {FAIL} ===")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
