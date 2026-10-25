# -*- coding: utf-8 -*-
"""打包云托管「代码包上传」用的识别服务 zip。

对照 server/.dockerignore 的排除清单，只打进构建必需内容：
  必含：Dockerfile、requirements.txt、.dockerignore、app/*.py、models/*.onnx
  排除：__pycache__/*.pyc、.env、.env.example、data/、*.sqlite3、tools/、*.bat/*.ps1、
        env//venv/、deploy/、docker-compose.yml、Dockerfile.gpu、.git、*.md、tests/
zip 根目录必须是 Dockerfile（云托管解压后按根目录 Dockerfile 构建）。

用法：python scripts/package_vision.py
      python scripts/package_vision.py --out dist/xxx.zip   # 指定输出名
"""
import datetime
import os
import shutil
import sys
import tempfile
import zipfile

SRC = r'E:\Agent\project\stray-animals\server'
OUT_DIR = r'E:\Agent\project\stray-animals\dist'

ROOT_FILES = ['Dockerfile', 'requirements.txt', '.dockerignore']
DIRS = ['app', 'models']

# 必须进包的模块。**不写死总数** —— 早期这里是 `len(app_pys) == 8`，加一个
# attrs.py 就整条打包流程 AssertionError，而这本是正常的代码演进。
# 校验意图（关键模块都在）而不是校验实现细节（恰好几个文件）。
REQUIRED_MODULES = {
    '__init__.py', 'main.py', 'config.py', 'engine.py', 'attrs.py',
    'media.py', 'index_store.py', 'sqlite_store.py', 'cos_store.py',
}
# 必须进包的模型。漏掉 yolov8n 不会报错，只会在线上静默退化成「整图提特征」——
# 正是「代码改了、线上没生效」最难查的一类，所以在打包这关就卡死。
REQUIRED_MODELS = ['models/reid.onnx', 'models/yolov8n.onnx']

# 与 .dockerignore 对齐的硬排除
EXCLUDE_DIRS = {'__pycache__', 'env', 'venv', 'deploy', 'tools', 'data', '.git'}
EXCLUDE_SUFFIX = ('.pyc', '.pyo', '.md', '.bat', '.ps1', '.sqlite3', '.env', '.env.example')
EXCLUDE_NAMES = {'docker-compose.yml', 'Dockerfile.gpu', '.gitignore', 'start.bat'}


def skip(name):
    return name in EXCLUDE_NAMES or name.endswith(EXCLUDE_SUFFIX)


def main():
    # 输出名默认带当天日期：写死日期会让「今天打的包」和「上周的包」在 dist/ 里
    # 长得一模一样，上传时抓错文件的概率不低。
    out = None
    argv = sys.argv[1:]
    if '--out' in argv:
        out = argv[argv.index('--out') + 1]
    if not out:
        stamp = datetime.date.today().strftime('%Y%m%d')
        out = os.path.join(OUT_DIR, 'catcampus-vision-%s.zip' % stamp)
    out = os.path.abspath(out)

    stage = os.path.join(tempfile.gettempdir(), 'catcampus-vision-pkg')
    if os.path.exists(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    os.makedirs(os.path.dirname(out) or OUT_DIR, exist_ok=True)

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
    for rel in REQUIRED_MODELS:
        assert os.path.isfile(os.path.join(stage, rel)), '%s 缺失（线上会静默降级）' % rel
    app_pys = set(f for f in os.listdir(os.path.join(stage, 'app')) if f.endswith('.py'))
    missing = REQUIRED_MODULES - app_pys
    assert not missing, 'app/ 缺模块: %s' % sorted(missing)
    assert not os.path.exists(os.path.join(stage, 'app', '__pycache__')), '__pycache__ 泄漏'
    assert not os.path.exists(os.path.join(stage, 'tests')), 'tests/ 泄漏进部署包'

    # 4) 生成 zip（相对路径，Dockerfile 位于根）
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, dirs, files in os.walk(stage):
            dirs[:] = [x for x in dirs if x not in EXCLUDE_DIRS]
            for fn in files:
                if skip(fn):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, stage).replace(os.sep, '/')
                zf.write(full, rel)

    # 5) 校验 zip 内容
    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
        bad = zf.testzip()
        assert bad is None, 'zip 损坏: ' + bad
        for req in ['Dockerfile', 'requirements.txt', '.dockerignore'] + REQUIRED_MODELS:
            assert req in names, 'zip 根缺少 ' + req
        leaks = [n for n in names
                 if '__pycache__' in n or n.endswith('.pyc') or n.startswith('data/')
                 or n.startswith('tools/') or n.startswith('deploy/')
                 or n.endswith('.md') or n.endswith('.bat') or n.endswith('.ps1')
                 or n.endswith('.env') or 'docker-compose' in n or 'Dockerfile.gpu' in n]
        assert not leaks, 'zip 含违禁条目: %s' % leaks
        zapp = set(n.split('/', 1)[1] for n in names
                   if n.startswith('app/') and n.endswith('.py'))
        zmissing = REQUIRED_MODULES - zapp
        assert not zmissing, 'zip 内 app/ 缺模块: %s' % sorted(zmissing)
        assert not any(n.startswith('tests/') for n in names), 'zip 含 tests/'

    print('OK -> %s' % out)
    print('size: %.2f MB' % (os.path.getsize(out) / 1024.0 / 1024.0))
    print('entries:')
    with zipfile.ZipFile(out) as zf:
        for info in sorted(zf.infolist(), key=lambda i: i.filename):
            print('  %12s  %s' % (format(info.file_size, ','), info.filename))
    shutil.rmtree(stage, ignore_errors=True)


if __name__ == '__main__':
    main()
