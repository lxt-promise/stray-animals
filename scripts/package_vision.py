# -*- coding: utf-8 -*-
"""打包云托管「代码包上传」用的识别服务 zip。

对照 server/.dockerignore 的排除清单，只打进构建必需内容：
  必含：Dockerfile、requirements.txt、.dockerignore、app/*.py（8 个）、models/reid.onnx
  排除：__pycache__/*.pyc、.env、.env.example、data/、*.sqlite3、tools/、*.bat/*.ps1、
        env//venv/、deploy/、docker-compose.yml、Dockerfile.gpu、.git、*.md、tests/
zip 根目录必须是 Dockerfile（云托管解压后按根目录 Dockerfile 构建）。

用法：python scripts/package_vision.py
"""
import os
import shutil
import tempfile
import zipfile

SRC = r'E:\Agent\project\stray-animals\server'
OUT_DIR = r'E:\Agent\project\stray-animals\dist'
OUT = os.path.join(OUT_DIR, 'catcampus-vision-20261014.zip')

ROOT_FILES = ['Dockerfile', 'requirements.txt', '.dockerignore']
DIRS = ['app', 'models']

# 与 .dockerignore 对齐的硬排除
EXCLUDE_DIRS = {'__pycache__', 'env', 'venv', 'deploy', 'tools', 'data', '.git'}
EXCLUDE_SUFFIX = ('.pyc', '.pyo', '.md', '.bat', '.ps1', '.sqlite3', '.env', '.env.example')
EXCLUDE_NAMES = {'docker-compose.yml', 'Dockerfile.gpu', '.gitignore', 'start.bat'}


def skip(name):
    return name in EXCLUDE_NAMES or name.endswith(EXCLUDE_SUFFIX)


def main():
    stage = os.path.join(tempfile.gettempdir(), 'catcampus-vision-pkg')
    if os.path.exists(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    os.makedirs(OUT_DIR, exist_ok=True)

    # 1) 根目录文件
    for f in ROOT_FILES:
        src_f = os.path.join(SRC, f)
        assert os.path.isfile(src_f), 'missing ' + src_f
        shutil.copy2(src_f, os.path.join(stage, f))

    # 2) app/ 与 models/（复制时剔除缓存目录）
    for d in DIRS:
        src_d = os.path.join(SRC, d)
        assert os.path.isdir(src_d), 'missing ' + src_d
        dst_d = os.path.join(stage, d)
        for root, dirs, files in os.walk(src_d):
            dirs[:] = [x for x in dirs if x not in EXCLUDE_DIRS]
            rel_root = os.path.relpath(root, src_d)
            target_root = dst_d if rel_root == '.' else os.path.join(dst_d, rel_root)
            os.makedirs(target_root, exist_ok=True)
            for fn in files:
                if skip(fn):
                    continue
                shutil.copy2(os.path.join(root, fn), os.path.join(target_root, fn))

    # 3) 打包前断言：staging 内容正确
    assert os.path.isfile(os.path.join(stage, 'Dockerfile')), 'Dockerfile 不在 staging 根'
    assert os.path.isfile(os.path.join(stage, 'models', 'reid.onnx')), 'reid.onnx 缺失'
    app_pys = sorted(f for f in os.listdir(os.path.join(stage, 'app')) if f.endswith('.py'))
    assert len(app_pys) == 8, 'app/ 应为 8 个 py，实际 %d: %s' % (len(app_pys), app_pys)
    assert not os.path.exists(os.path.join(stage, 'app', '__pycache__')), '__pycache__ 泄漏'
    assert not os.path.exists(os.path.join(stage, 'tests')), 'tests/ 泄漏进部署包'

    # 4) 生成 zip（相对路径，Dockerfile 位于根）
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, dirs, files in os.walk(stage):
            dirs[:] = [x for x in dirs if x not in EXCLUDE_DIRS]
            for fn in files:
                if skip(fn):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, stage).replace(os.sep, '/')
                zf.write(full, rel)

    # 5) 校验 zip 内容
    with zipfile.ZipFile(OUT) as zf:
        names = zf.namelist()
        bad = zf.testzip()
        assert bad is None, 'zip 损坏: ' + bad
        for req in ('Dockerfile', 'requirements.txt', '.dockerignore', 'models/reid.onnx'):
            assert req in names, 'zip 根缺少 ' + req
        leaks = [n for n in names
                 if '__pycache__' in n or n.endswith('.pyc') or n.startswith('data/')
                 or n.startswith('tools/') or n.startswith('deploy/')
                 or n.endswith('.md') or n.endswith('.bat') or n.endswith('.ps1')
                 or n.endswith('.env') or 'docker-compose' in n or 'Dockerfile.gpu' in n]
        assert not leaks, 'zip 含违禁条目: %s' % leaks
        zapp = sorted(n for n in names if n.startswith('app/') and n.endswith('.py'))
        assert len(zapp) == 8, 'zip 内 app/*.py 数量异常: %s' % zapp
        assert not any(n.startswith('tests/') for n in names), 'zip 含 tests/'

    print('OK -> %s' % OUT)
    print('size: %.2f MB' % (os.path.getsize(OUT) / 1024.0 / 1024.0))
    print('entries:')
    with zipfile.ZipFile(OUT) as zf:
        for info in sorted(zf.infolist(), key=lambda i: i.filename):
            print('  %12s  %s' % (format(info.file_size, ','), info.filename))
    shutil.rmtree(stage, ignore_errors=True)


if __name__ == '__main__':
    main()
