# -*- coding: utf-8 -*-
"""
图片背景移除（u2netp ONNX，纯 CPU，模型仅 4.3MB）

由 picture-service/server.js 调用：
  python remove_bg.py --input 原图路径 --out 输出 PNG 路径
输出带透明通道的 PNG。

2026-10-31：推理实现统一到 `app.matting`（识别链路用的也是同一份）。
本脚本只保留 CLI + 进度输出，避免「工具抠一种、线上抠另一种」的漂移。
新增 `--box`：把掩膜外接框（原图坐标）一并写进进度 JSON，供上游裁剪复用。
"""
import argparse
import json
import os
import sys
import traceback

ROOT = os.path.dirname(os.path.abspath(__file__))
# 优先使用项目根目录下的共享模型仓库 env/models，再回退到本服务目录
ENV_MODELS = os.path.join(os.path.dirname(ROOT), 'env', 'models')
LEGACY_MODELS = (
    os.path.join(ENV_MODELS, 'u2netp.onnx'),
    os.path.join(ROOT, '.models', 'u2netp.onnx'),
    os.path.join(ROOT, 'models', 'u2netp.onnx'),
)

# 与其它 tools 一致：把 server 根目录加进 sys.path，复用 app 包
sys.path.insert(0, os.path.dirname(ROOT))

from app import config, matting  # noqa: E402


def emit(obj):
    print('__' + 'PROGRESS' + '__ ' + json.dumps(obj, ensure_ascii=False), flush=True)


def progress(phase, pct):
    emit({'phase': phase, 'progress': max(0, min(100, int(pct)))})


def ensure_model():
    """决定模型路径。app.matting 只自动发现 server/models；
    这里补上历史位置 env/models（picture-service 依赖它）。"""
    path = matting.model_path()
    if path:
        return path
    for cand in LEGACY_MODELS:
        if os.path.exists(cand):
            config.MATTING_ONNX = cand
            return cand
    raise RuntimeError('找不到抠图模型 u2netp.onnx（查找位置：%s）' % '、'.join(LEGACY_MODELS))


def run(input_path, out_path, with_box=False):
    import numpy as np
    from PIL import Image

    progress('加载模型', 10)
    ensure_model()

    progress('读取图片', 15)
    img = Image.open(input_path).convert('RGB')

    progress('推理中', 40)
    fg = matting.foreground(img)
    if not fg.get('ok') or fg.get('mask') is None:
        raise RuntimeError('抠图失败：模型没有产生有效前景')

    progress('合成结果', 80)
    w, h = img.size
    mask = fg['mask']
    base = np.asarray(img).astype(np.uint8)
    alpha = (mask * 255).astype(np.uint8)
    out_img = Image.fromarray(np.dstack([base, alpha]), mode='RGBA')

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    out_img.save(out_path, 'PNG', optimize=True)
    progress('完成', 100)
    done = {'phase': '完成', 'progress': 100, 'output': out_path,
            'size': os.path.getsize(out_path)}
    if with_box:
        done['box'] = fg.get('box')
        done['coverage'] = round(float(fg.get('coverage') or 0.0), 4)
        done['tight'] = round(float(fg.get('tight') or 0.0), 4)
    emit(done)


if __name__ == '__main__':
    try:
        ap = argparse.ArgumentParser()
        ap.add_argument('--input', required=True)
        ap.add_argument('--out', required=True)
        ap.add_argument('--box', action='store_true',
                        help='在完成的进度 JSON 里附带掩膜外接框（原图坐标）')
        args = ap.parse_args()
        run(args.input, args.out, with_box=args.box)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        emit({'error': str(e) or e.__class__.__name__})
        sys.exit(1)
