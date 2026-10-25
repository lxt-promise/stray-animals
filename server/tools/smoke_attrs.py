"""端到端冒烟：/v1/recognize 的属性链路（不联网、不需要模型）。

用 monkeypatch 把 media.fetch_image 换成合成图，跑完整的 recognize 流程，
验证 tags / features / meta 的形态符合契约。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("INDEX_BACKEND", "sqlite")

from PIL import Image  # noqa: E402

from app import main, media  # noqa: E402

CASES = {
    "白猫": (238, 235, 228),
    "橘猫": (222, 152, 84),
    "黑猫": (46, 44, 42),
    "灰猫": (150, 152, 156),
    "草地背景": (90, 140, 70),
}


def run(rgb):
    media.fetch_image = lambda url: Image.new("RGB", (256, 256), rgb)
    req = main.RecognizeReq(url="http://x/a.jpg", type="image", schoolId="s1")
    r = main.recognize(req, None)
    f, m = r["features"], r["meta"]
    return f, m


for name, rgb in CASES.items():
    f, m = run(rgb)
    tags = " ".join("%s=%s" % (t["k"], t["v"]) for t in f["tags"])
    print("%-8s color=%-6s pattern=%-5s breed=%-6s conf=%.2f src=%-9s identified=%s"
          % (name, f["color"] or "-", f["pattern"] or "-", f["breed"] or "-",
             f["confidence"], m["attrSource"] or "-", m["identified"]))
    print("         tags: %s" % tags)
    if m["attrReason"]:
        print("         reason: %s" % m["attrReason"])

print("\nhealth:", {k: v for k, v in main.health().items()
                    if k in ("attrs", "attrSource", "identifyMin", "minSim")})
