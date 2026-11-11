"""从标注原图批量生成增广样本，检验并提升算法对拍摄条件的鲁棒性。

增广类型（全部保持花色标签不变，文件名 = 原名__类型.jpg）：
  crop70    中心裁剪 70%          —— 猫体占画面比例变化 / 取景偏移
  rot12     旋转 12°（灰边填充）   —— 手持拍摄的地平线倾斜
  rot90     旋转 90°              —— 竖拍/横拍，分带统计的方向鲁棒性
  dark55    亮度 ×0.55            —— 阴天/背光欠曝
  bright16  亮度 ×1.6             —— 强光过曝
  gamma35   gamma 0.35 暗化       —— 模拟夜间（比线性变暗更真实：
                                  暗部压得更狠，白毛掉进灰桶的方式一致）

只做「不改花色」的变换：不镜像（花色左右分布会变，分带证据失真）、
不加噪声（JPEG 压缩本身就是噪声）、不调色相（等于人为改毛色）。

用法：
  env\\Scripts\\python.exe tools\\make_augmented.py
输出： E:\\Agent\\worker\\东南大学-猫\\增广\\
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageEnhance

SRC_DIRS = [Path(r"E:\Agent\worker\东南大学-猫\原图"),
            Path(r"E:\Agent\worker\东南大学-猫\标准照"),
            Path(r"E:\Agent\worker\东南大学-猫\test")]
OUT_DIR = Path(r"E:\Agent\worker\东南大学-猫\增广")


def gamma_table(gamma: float):
    """gamma < 1 变暗（模拟夜间欠曝），>1 变亮。"""
    return [min(255, int((i / 255.0) ** (1.0 / gamma) * 255 + 0.5))
            for i in range(256)]


def variants(im: Image.Image):
    """返回 [(后缀, 图片), ...]。"""
    out = []
    w, h = im.size
    # crop70：中心 70%
    cw, ch = int(w * 0.70), int(h * 0.70)
    out.append(("crop70", im.crop(((w - cw) // 2, (h - ch) // 2,
                                   (w + cw) // 2, (h + ch) // 2))))
    # rot12：旋转 12°，灰边填充（模拟室外水泥地/天空的中间调）
    out.append(("rot12", im.rotate(12, expand=True, fillcolor=(128, 128, 128))))
    out.append(("rot90", im.rotate(90, expand=True)))
    out.append(("dark55", ImageEnhance.Brightness(im).enhance(0.55)))
    out.append(("bright16", ImageEnhance.Brightness(im).enhance(1.6)))
    # RGB 图的 point() 需要 256×3 的 LUT
    lut = gamma_table(0.35) * 3
    out.append(("gamma35", im.point(lut)))
    return out


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    OUT_DIR.mkdir(exist_ok=True)
    n_src = n_out = 0
    for d in SRC_DIRS:
        for p in sorted(d.iterdir()):
            if p.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            im = Image.open(p).convert("RGB")
            # 长边压到 1400 再增广：与实拍上传量级一致，也省磁盘
            im.thumbnail((1400, 1400), Image.LANCZOS)
            for suffix, v in variants(im):
                dst = OUT_DIR / f"{p.stem}__{suffix}.jpg"
                v.save(dst, quality=90)
                n_out += 1
            n_src += 1
    print(f"源图 {n_src} 张 → 增广样本 {n_out} 张（目录：{OUT_DIR}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
