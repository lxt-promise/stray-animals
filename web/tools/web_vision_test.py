# -*- coding: utf-8 -*-
"""识别测试台的端到端验收（Web 链路）。

链路：后端 /api/vision/* → 本地识别服务 → 返回候选
验证 3 个真实场景：
  1) health 能通，且 provider=onnx
  2) 传一张猫照，识别服务能从「后端生成的绝对 URL」下载到图（这是最容易出错的一环）
  3) 分数有区分度（不是清一色 99 分）

前置：
  - 识别服务 :8090（server/ 目录 uv 起）
  - 后端     :8080（web/backend mvn spring-boot:run）

运行：
  E:\\Agent\\project\\stray-animals\\env\\Scripts\\python tools\\web_vision_test.py
"""
from __future__ import annotations

import io
import json
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from PIL import Image

BACKEND = "http://127.0.0.1:8080"
VISION = "http://127.0.0.1:8090"
PORT = 8098

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


# 识别服务要能直接下载到内网地址（127.0.0.1:8099），这里起个小图服务
class H(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        d = ASSETS.get(self.path.lstrip("/").split("?")[0])
        if not d:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(d)))
        self.end_headers()
        self.wfile.write(d)

    def log_message(self, *a):
        pass


def main() -> int:
    print("=== Web 识别测试台 端到端验收 ===\n")

    try:
        h = httpx.get(f"{BACKEND}/api/vision/health", timeout=30).json()
    except Exception as e:
        print(f"后端未启动：{e}")
        return 1
    check("后端 /api/vision/health 可访问", h.get("code") == 0, str(h)[:200])
    data = h.get("data") or {}
    print(f"      识别服务 {data.get('endpoint')} provider={data.get('provider')} dim={data.get('dim')}")
    check("识别服务在线", data.get("ok") is True, str(data))
    check("真模型已加载（provider=onnx）", data.get("provider") == "onnx", f"provider={data.get('provider')}")

    # 真实猫照片
    p = Path(__file__).resolve().parents[2] / "server" / "data" / "_cats.jpeg"
    if not p.exists():
        try:
            u = ("https://hf-mirror.com/datasets/huggingface/documentation-images"
                 "/resolve/main/cats.jpeg")
            p.parent.mkdir(exist_ok=True)
            p.write_bytes(urllib.request.urlopen(
                urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read())
        except Exception as e:
            print(f"素材缺失且下载失败：{e}")
            return 1

    grid = Image.open(p).convert("RGB")
    W, Hh = grid.size
    hw, hh = W // 2, Hh // 2
    quads = {
        "c1": grid.crop((0, 0, hw, hh)),
        "c2": grid.crop((hw, 0, W, hh)),
        "c3": grid.crop((0, hh, hw, Hh)),
    }
    for k, im in quads.items():
        b = io.BytesIO()
        im.save(b, "JPEG", quality=92)
        ASSETS[k] = b.getvalue()

    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    print("\n--- 1. 后端把相对路径补成绝对 URL ---")
    # 直接调 /api/vision/recognize，url 指向内网小服务（模拟 /uploads 的绝对地址）
    url = f"http://127.0.0.1:{PORT}/c1"
    r = httpx.post(f"{BACKEND}/api/vision/recognize", json={"url": url}, timeout=180).json()
    check("识别接口返回 code=0", r.get("code") == 0, str(r)[:300])
    body = r.get("data") or {}
    cands = body.get("candidates", [])
    print(f"      候选：{[(c['catId'], c['name'], c['score'], c.get('rawSim')) for c in cands][:5]}")
    print(f"      meta：{body.get('meta')}")

    print("\n--- 2. 建立特征库（用后端代理） ---")
    b = httpx.post(f"{BACKEND}/api/vision/build-index", timeout=300).json()
    if b.get("code") == 0:
        check("建库接口返回 code=0", True)
        print(f"      {b.get('data')}")
    else:
        # H2 是空库时没有猫档案，属预期，不算链路问题
        empty_db = "没有可建库的猫档案" in str(b.get("msg"))
        print(f"      [跳过] {b.get('msg')}"
              + ("（当前是空库，登录 Web 后新建几只猫再来建库）" if empty_db else ""))
        if not empty_db:
            check("建库接口返回 code=0", False, str(b)[:200])

    print("\n--- 3. 识别分数是否有区分度 ---")
    if cands:
        scores = [c["score"] for c in cands]
        print(f"      分数：{scores}")
        check("不是清一色 99 分（阈值已标定）", not (len(scores) > 1 and len(set(scores)) == 1),
              f"scores={scores}")
        raw = [c.get("rawSim") for c in cands if c.get("rawSim") is not None]
        if raw:
            print(f"      原始余弦：{raw}")
            check("原始余弦在合理区间 (0.4~1.0)", all(0.4 <= x <= 1.0 for x in raw), f"{raw}")
    else:
        print("      没有候选（特征库可能为空）")

    print("\n--- 4. 响应体不含 768 维向量（已剔除，省带宽） ---")
    check("features.embedding 已剔除", "embedding" not in (body.get("features") or {}),
          str(list((body.get("features") or {}).keys())))

    print(f"\n=== PASS {PASS} / FAIL {FAIL} ===")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
