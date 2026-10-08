"""精确检测 Wheel 平台兼容性。

坑：torch-2.14.0-cp313-cp313-win_amd64.whl 的标签是多段的，
不能用 filename.split('-')[-1] 去取，否则只能拿到 "win_amd64",
会把明明可用的 cp313 轮子误判成不可用。
"""
import json
import sys
import urllib.request

PY = f"cp{sys.version_info.major}{sys.version_info.minor}"
PLAT = "win_amd64"

print(f"解释器: Python {sys.version.split()[0]} 目标标签: {PY}-{PLAT}\n")
print(f"{'包':<26}{'最新版':<14}{'结果'}")
print("-" * 70)

for pkg in ["onnxruntime", "torch", "timm", "ultralytics", "opencv-python-headless", "onnx"]:
    try:
        with urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/json", timeout=30) as r:
            d = json.load(r)
    except Exception as e:
        print(f"{pkg:<26}{'':<14}查询失败 {e}")
        continue

    latest = d["info"]["version"]
    files = d["releases"].get(latest, [])
    wheels = [f["filename"] for f in files if f["filename"].endswith(".whl")]

    hit = [w for w in wheels if PY in w and PLAT in w]
    size = ""
    if hit:
        mb = next((f["size"] for f in files if f["filename"] == hit[0]), 0) / 2 ** 20
        size = f"  {mb:.0f} MB"
    verdict = f"OK  {len(hit)} 个匹配{size}" if hit else "X 无匹配"
    if hit:
        verdict += f"  e.g. {hit[0]}"

    print(f"{pkg:<26}{latest:<14}{verdict}")

    # 若无匹配，找出该包支持的最高 cp 版本，给出降级建议
    if not hit:
        cps = sorted({t for w in wheels for t in w.split("-") if t.startswith("cp") and t[2:5].isdigit()},
                     reverse=True)
        print(f"{'':<26}{'':<14}该包提供的最高 ABI: {cps[:4] if cps else '无 wheel'}")

print("\n结论：以上为 PyPI 元数据查询，未安装任何包。")
