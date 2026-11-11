"""pattern_recognize 的批量回归测试。

标注集（文件名里含猫的花色关键词）：
  E:\\Agent\\worker\\东南大学-猫\\原图     19 张实拍
  E:\\Agent\\worker\\东南大学-猫\\标准照   16 张（含玄猫/玳瑁）
  E:\\Agent\\worker\\东南大学-猫\\test       6 张
  E:\\Agent\\worker\\东南大学-猫\\增广     make_augmented.py 生成的
                                        裁剪/旋转/亮度变体（文件名 =
                                        原名__aug类型.jpg）

解析出期望值后逐一识别，输出混淆矩阵与逐张对照；支持 --fast
（跳过增广集）与 --only <子串>（只测部分样本）。

用法：
  env\\Scripts\\python.exe tools\\test_pattern_recognize.py [--fast] [--only 增广]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pattern_recognize import recognize  # noqa: E402

BASE = Path(r"E:\Agent\worker\东南大学-猫")
DEFAULT_DIRS = [BASE / "原图", BASE / "标准照", BASE / "test", BASE / "增广"]

# 文件名关键词 → 期望的 pattern 枚举值（pattern_recognize 的取值体系）
KEYWORDS = [
    ("奶牛", "cow"), ("小奶牛", "cow"),
    ("三花", "calico"),
    ("狸花", "tabby"),
    ("玳瑁", "tortoiseshell"),
    ("橘", "orange"),
    ("白猫", "white"),
    ("玄猫", "black"),
    ("黑猫", "black"),
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true",
                    help="跳过增广集，只测原图/标准照/test")
    ap.add_argument("--only", default="",
                    help="只测文件名含此子串的样本")
    ap.add_argument("dirs", nargs="*", help="覆盖默认目录列表")
    args = ap.parse_args()

    dirs = [Path(d) for d in args.dirs] if args.dirs else list(DEFAULT_DIRS)
    if args.fast:
        dirs = [d for d in dirs if d.name != "增广"]
    files = sorted(p for d in dirs if d.is_dir() for p in d.iterdir()
                   if p.suffix.lower() in (".jpg", ".jpeg", ".png")
                   and not p.name.startswith("."))
    if args.only:
        files = [p for p in files if args.only in p.name]
    if not files:
        print("目录里没有图片", file=sys.stderr)
        return 2

    total = hit = coat_hit = 0
    confusion: dict = {}
    misses = []
    # 按增广类型分组统计：原始样本记作 orig
    per_aug: dict = {}
    for p in files:
        expect = expected_of(p.stem)
        if not expect:
            print(f"跳过（文件名无标签）：{p.name}")
            continue
        total += 1
        aug = p.stem.split("__")[1] if "__" in p.stem else "orig"
        g = per_aug.setdefault(aug, [0, 0])
        g[1] += 1
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
        g[0] += ok
        coat_desc = r.get("coat", {}).get("desc", "?") if r else "?"
        cok = coat_ok(expect, coat_desc)
        coat_hit += cok
        mark = "✓" if ok else "✗"
        cmark = "✓" if cok else "✗"
        print(f"{mark} {p.name:32s} 期望={expect:8s} 实际={got}")
        if not ok or not cok:
            print(f"  毛色{cmark} {coat_desc}  "
                  f"花纹={r.get('markings', {}).get('desc', '?')}")
            print(f"    调色板={r.get('palette')}  斑块度={r.get('patchiness')} "
                  f"条纹分={r.get('stripe')}")
        if not ok:
            misses.append((p.name, expect, got))

    print(f"\n品种准确率：{hit}/{total} = {hit / total:.0%}" if total else "无样本")
    print(f"毛色一致率：{coat_hit}/{total} = {coat_hit / total:.0%}" if total else "")
    print("按扰动类型：")
    for aug, (h, n) in sorted(per_aug.items(), key=lambda kv: -kv[1][1]):
        print(f"  {aug:10s} {h:3d}/{n:3d} = {h / n:.0%}")
    if misses:
        print("错例：" + "、".join(f"{n}({e}→{g})" for n, e, g in misses))
    print("混淆矩阵（行=期望，列=实际）：")
    labels = sorted({k for v in confusion.values() for k in v} | set(confusion))
    head = "        " + "".join(f"{c:>14}" for c in labels)
    print(head)
    for r in labels:
        row = confusion.get(r, {})
        print(f"{r:>8}" + "".join(f"{row.get(c, 0):>14}" for c in labels))
    return 0


if __name__ == "__main__":
    sys.exit(main())
