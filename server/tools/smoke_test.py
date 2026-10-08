#!/usr/bin/env python3
"""本地自检：不起 Docker、不装模型，也能验证整条链路是通的。

会做这几件事：
  1. 起一个临时 HTTP 服务提供测试图片（模拟微信云存储临时链接）
  2. 用占位引擎给 2 只猫建特征库
  3. 用同一张图去认，应该拿到高分；用另一只猫的图去认，应该拿低分
  4. 校验返回的字段结构与云函数 vision.js 的契约一致

运行： python tools/smoke_test.py
"""
import http.server
import os
import socketserver
import sys
import tempfile
import threading
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="catcampus_smoke_"))
IMG_DIR = TMP / "imgs"
IMG_DIR.mkdir(parents=True, exist_ok=True)

os.environ["INDEX_DB"] = str(TMP / "index.sqlite3")
os.environ["API_TOKEN"] = "smoke-token"
os.environ["REID_ONNX"] = ""
os.environ["DETECT_ONNX"] = ""

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402


def make_img(name: str, rgb, seed: int):
    """画一张有规律的图，保证不同 seed 出来的像素不同（占位引擎按像素哈希）。"""
    im = Image.new("RGB", (256, 256), rgb)
    px = im.load()
    for y in range(0, 256, 8):
        for x in range(0, 256, 8):
            if (x + y + seed * 7) % 3 == 0:
                px[x, y] = (255, 255, 255)
    p = IMG_DIR / name
    im.save(p, "JPEG", quality=90)
    return p


CAT_A = make_img("a.jpg", (230, 150, 60), 1)    # 假装这是「橘座」
CAT_B = make_img("b.jpg", (60, 70, 90), 2)      # 假装这是「灰灰」


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(IMG_DIR), **kw)

    def log_message(self, *a):
        pass


httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app import config  # noqa: E402

client = TestClient(app)
H = {"Authorization": "Bearer smoke-token"}
ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS  {name}")
    else:
        fail += 1
        print(f"  FAIL  {name} {extra}")


print("=== 1. 健康检查 ===")
r = client.get("/health")
j = r.json()
print(" ", j)
check("服务可访问", r.status_code == 200)
check("引擎已加载", j.get("dim", 0) > 0)
check("报告 ffmpeg 可用性", "ffmpeg" in j)

print("=== 2. 鉴权 ===")
check("无 token 被拒", client.post("/v1/embed", json={"url": f"{BASE}/a.jpg"}).status_code == 401)
check("错 token 被拒",
      client.post("/v1/embed", json={"url": f"{BASE}/a.jpg"},
                  headers={"Authorization": "Bearer wrong"}).status_code == 401)

print("=== 3. 批量建库 ===")
r = client.post("/v1/index/build", json={
    "schoolId": "sch_smoke",
    "photosPerCat": 6,
    "cats": [
        {"id": "cat_a", "name": "橘座", "photos": [f"{BASE}/a.jpg"]},
        {"id": "cat_b", "name": "灰灰", "photos": [f"{BASE}/b.jpg"]},
    ],
}, headers=H)
print(" ", r.json())
check("建库返回 200", r.status_code == 200)
check("两只猫都入库", r.json().get("built") == 2)

print("=== 4. 同图识别应该高分 ===")
r = client.post("/v1/recognize", json={
    "url": f"{BASE}/a.jpg", "type": "image", "frames": 1, "schoolId": "sch_smoke",
    "cats": [{"id": "cat_a", "name": "橘座", "photos": [f"{BASE}/a.jpg"]},
             {"id": "cat_b", "name": "灰灰", "photos": [f"{BASE}/b.jpg"]}],
}, headers=H)
j = r.json()
print("  top:", j["candidates"][0] if j.get("candidates") else None)
check("识别返回 200", r.status_code == 200)
check("有候选", len(j.get("candidates", [])) > 0)
check("首位是橘座", j["candidates"][0]["catId"] == "cat_a")
check("首位高分(>90)", j["candidates"][0]["score"] > 90, j["candidates"][0]["score"])
check("返回 embedding", len(j["features"]["embedding"]) > 0)
check("candidates 字段齐全",
      all(k in j["candidates"][0] for k in ("catId", "name", "avatar", "score", "reason")))
check("features 字段齐全",
      all(k in j["features"] for k in ("tags", "pattern", "color", "confidence")))

print("=== 5. 跨猫识别应该低分 ===")
r = client.post("/v1/recognize", json={
    "url": f"{BASE}/b.jpg", "type": "image", "frames": 1, "schoolId": "sch_smoke",
    "cats": [{"id": "cat_a", "name": "橘座", "photos": [f"{BASE}/a.jpg"]},
             {"id": "cat_b", "name": "灰灰", "photos": [f"{BASE}/b.jpg"]}],
}, headers=H)
j = r.json()
check("另一只猫图能认出灰灰", j["candidates"][0]["catId"] == "cat_b", j["candidates"][0])
check("橘座排到第二且分低", j["candidates"][-1]["catId"] == "cat_a")

print("=== 6. 视频路径（无 ffmpeg 时降级封面帧）===")
r = client.post("/v1/recognize", json={
    "url": f"{BASE}/a.jpg", "videoUrl": "", "type": "video", "frames": 4, "schoolId": "sch_smoke",
    "cats": [{"id": "cat_a", "name": "橘座", "photos": [f"{BASE}/a.jpg"]}],
}, headers=H)
check("视频类型不报错", r.status_code == 200, r.text[:200])
check("视频仍出候选", r.json().get("candidates"))

print("=== 7. 真实视频抽帧（需要 ffmpeg）===")
import subprocess  # noqa: E402

from app import media  # noqa: E402

if not media.ffmpeg_ok():
    print("  SKIP  未配置 ffmpeg，跳过视频抽帧用例")
else:
    vid = IMG_DIR / "clip.mp4"
    gen = [
        config.FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=15",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-pix_fmt", "yuv420p", "-shortest", "-c:v", "libx264", str(vid),
    ]
    try:
        subprocess.run(gen, timeout=60, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL  造测试视频失败 {e}")

    if vid.exists():
        r = client.post("/v1/recognize", json={
            "url": f"{BASE}/a.jpg", "videoUrl": f"{BASE}/clip.mp4",
            "type": "video", "frames": 6, "schoolId": "sch_smoke",
            "cats": [{"id": "cat_a", "name": "橘座", "photos": [f"{BASE}/a.jpg"]}],
        }, headers=H)
        j = r.json()
        got = j.get("meta", {}).get("frames", 0)
        print(f"  视频大小 {vid.stat().st_size / 1024:.0f} KB，抽到 {got} 帧")
        check("视频识别返回 200", r.status_code == 200, r.text[:200])
        check("确实抽到多帧（非退化封面帧）", got >= 2, f"frames={got}")
        check("视频也能出候选", bool(j.get("candidates")))
    else:
        print("  FAIL  测试视频未生成")

print("=== 8. 异常输入 ===")
check("空 url 报 400", client.post("/v1/recognize", json={"type": "image"}, headers=H).status_code == 400)

print(f"\n=== 结果 ===\nPASS {ok} / FAIL {fail}")
httpd.shutdown()
sys.exit(1 if fail else 0)
