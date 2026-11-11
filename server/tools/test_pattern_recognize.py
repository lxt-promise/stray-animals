"""pattern_recognize 的批量回归测试。

用 E:\\Agent\\worker\\东南大学-猫\\原图 下的实拍图做标注集：
文件名里含猫的花色（白猫 / 橘猫 / 狸花猫 / 奶牛猫 / 小奶牛 / 三花），
解析成期望值后逐一识别，输出混淆矩阵与逐张对照。

用法：
  env\\Scripts\\python.exe tools\\test_pattern_recognize.py [图片目录]
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pattern_recognize import recognize  # noqa: E402

DEFAULT_DIR = r"E:\Agent\worker\东南大学-猫\原图"

# 文件名关键词 → 期望的 pattern 枚举值（pattern_recognize 的取值体系）
KEYWORDS = [
    ("奶牛", "cow"), ("小奶牛", "cow"),
    ("三花", "calico"),
    ("狸花", "tabby"),
    ("橘", "orange"),
    ("白猫", "white"),
    ("黑猫", "black"),
    ("玳瑁", "tortoiseshell"),
]


def expected_of(name: str) -> str:
    for kw, val in KEYWORDS:
        if kw in name:
            return val
    return ""


# 文件名标签 → 毛色描述里应出现的关键词（毛色一致性检查）
COAT_KEYWORDS = {
    "orange": ("橘",),                       # 橘猫毛色必须含「橘」
    "white": ("白",),                        # 白猫毛色必须含「白」
    "cow": ("黑", "白"),                     # 奶牛必须黑白都有
    "calico": ("三色", "白"),                # 三花必须有三色或至少白
    "tabby": ("棕", "灰", "黑"),             # 狸花底毛棕/灰黑
}


def coat_ok(expect: str, coat_desc: str) -> bool:
    kws = COAT_KEYWORDS.get(expect)
    if not kws:
        return True
    return any(k in coat_desc for k in kws)


def main() -> int:
    # Windows 控制台默认 GBK，✓/✗ 等字符编不出来；统一改 UTF-8
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    d = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR)
    files = sorted(p for p in d.iterdir()
                   if p.suffix.lower() in (".jpg", ".jpeg", ".png")
                   and not p.name.startswith("."))
    if not files:
        print(f"目录里没有图片：{d}", file=sys.stderr)
        return 2

    total = hit = coat_hit = 0
    confusion: dict = {}
    misses = []
    for p in files:
        expect = expected_of(p.stem)
        if not expect:
            print(f"跳过（文件名无标签）：{p.name}")
            continue
        total += 1
        try:
            r = recognize(str(p))
            got = r["pattern"]
        except Exception as e:  # noqa: BLE001
            got = f"ERROR:{type(e).__name__}"
            r = {}
        pair = confusion.setdefault(expect, {})
        pair[got] = pair.get(got, 0) + 1
        ok = got == expect
        hit += ok
        coat_desc = r.get("coat", {}).get("desc", "?") if r else "?"
        cok = coat_ok(expect, coat_desc)
        coat_hit += cok
        mark = "✓" if ok else "✗"
        cmark = "✓" if cok else "✗"
        print(f"{mark} {p.name:32s} 期望={expect:8s} 实际={got}")
        print(f"  毛色{cmark} {coat_desc:20s} "
              f"花纹={r.get('markings', {}).get('desc', '?')}  "
              f"品种={r.get('breed', '?')}")
        if not ok:
            print(f"    调色板={r.get('palette')}  斑块度={r.get('patchiness')} "
                  f"条纹分={r.get('stripe')} 分带={r.get('bands')}")
        if not ok:
            misses.append((p.name, expect, got))

    print(f"\n品种准确率：{hit}/{total} = {hit / total:.0%}" if total else "无样本")
    print(f"毛色一致率：{coat_hit}/{total} = {coat_hit / total:.0%}" if total else "")
    print("混淆矩阵（行=期望，列=实际）：")
    labels = sorted({k for v in confusion.values() for k in v} | set(confusion))
    head = "        " + "".join(f"{c:>10}" for c in labels)
    print(head)
    for r in labels:
        row = confusion.get(r, {})
        print(f"{r:>8}" + "".join(f"{row.get(c, 0):>10}" for c in labels))
    return 0


if __name__ == "__main__":
    sys.exit(main())
