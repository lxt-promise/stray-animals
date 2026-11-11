# -*- coding: utf-8 -*-
"""打包云托管「代码包上传」用的识别服务 zip。

对照 server/.dockerignore 的排除清单，只打进构建必需内容：
  必含：Dockerfile、requirements.txt、.dockerignore、app/*.py、models/*.onnx、
        tools/*.py（整个工具目录；pattern_recognize.py 是运行时依赖，
        app/attrs.py 按路径加载它做花色判定）
  排除：__pycache__/*.pyc、.env、.env.example、data/、*.sqlite3、
        *.bat/*.ps1、env//venv/、deploy/、docker-compose.yml、Dockerfile.gpu、
        .git、*.md、tests/
zip 根目录必须是 Dockerfile（云托管解压后按根目录 Dockerfile 构建）。

用法：python scripts/package_vision.py
      python scripts/package_vision.py --out dist/xxx.zip   # 指定输出名
"""
import datetime
import hashlib
import os
import shutil
import sys
import tempfile
import zipfile

SRC = r'E:\Agent\project\stray-animals\server'
OUT_DIR = r'E:\Agent\project\stray-animals\dist'

ROOT_FILES = ['Dockerfile', 'requirements.txt', '.dockerignore']
DIRS = ['app', 'models', 'tools']

# 必须进包的模块。**不写死总数** —— 早期这里是 `len(app_pys) == 8`，加一个
# attrs.py 就整条打包流程 AssertionError，而这本是正常的代码演进。
# 校验意图（关键模块都在）而不是校验实现细节（恰好几个文件）。
REQUIRED_MODULES = {
    '__init__.py', 'main.py', 'config.py', 'engine.py', 'attrs.py',
    'media.py', 'index_store.py', 'sqlite_store.py', 'cos_store.py',
}
# 必须进包的模型。漏掉 yolov8n 不会报错，只会在线上静默退化成「整图提特征」——
# 漏掉生效的 reid 模型（mega_descriptor_t.onnx）则特征引擎直接退化成 hash 占位，
# 建库照跑、识别全错，是最难查的一类，所以在打包这关就卡死。
# 注意：models/reid.onnx（DINOv2 ViT-Base，86MB）是 reid 的**回退**模型，
# 引擎优先用 mega_descriptor_t.onnx；按需求不把它打进包（省体积），保留 mega 即可。
REQUIRED_MODELS = ['models/mega_descriptor_t.onnx', 'models/yolov8n.onnx']

# tools/ 是**整个目录**进包的（开发脚本一并带上，体积 <1MB，便于线上排查）。
# 其中 pattern_recognize.py 是运行时依赖：app/attrs.py 用 importlib 按路径加载它
# 做花色判定，漏打包不会报错，只会在线上静默回退 legacy（/health 的
# attr.source 会一直是 heuristic），所以和模型一样在打包这关就卡死。
REQUIRED_TOOLS = ['tools/pattern_recognize.py']

# 与 .dockerignore 对齐的硬排除（tools/ 不再整目录排除：要带 REQUIRED_TOOLS）
EXCLUDE_DIRS = {'__pycache__', 'env', 'venv', 'deploy', 'data', '.git'}
EXCLUDE_SUFFIX = ('.pyc', '.pyo', '.md', '.bat', '.ps1', '.sqlite3', '.env', '.env.example')
EXCLUDE_NAMES = {'docker-compose.yml', 'Dockerfile.gpu', '.gitignore', 'start.bat', 'reid.onnx'}


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

    # 2) app/、models/、tools/（复制时剔除缓存目录；tools/ 整个进包）
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

    # 2.5) 兜底：DIRS 已把整个 tools/ 复制过来，这里再确认运行时依赖确实在。
    #      宁可在本地打包时失败，也不要线上「不报错但静默回退 legacy」。
    for rel in REQUIRED_TOOLS:
        src_f = os.path.join(SRC, rel)
        assert os.path.isfile(src_f), 'missing ' + src_f
        assert os.path.isfile(os.path.join(stage, rel)), 'staging 缺少 ' + rel

    # 3) 打包前断言：staging 内容正确
    assert os.path.isfile(os.path.join(stage, 'Dockerfile')), 'Dockerfile 不在 staging 根'
    for rel in REQUIRED_MODELS + REQUIRED_TOOLS:
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
        for req in ['Dockerfile', 'requirements.txt', '.dockerignore'] + REQUIRED_MODELS + REQUIRED_TOOLS:
            assert req in names, 'zip 根缺少 ' + req
        leaks = [n for n in names
                 if '__pycache__' in n or n.endswith('.pyc') or n.startswith('data/')
                 or n.startswith('deploy/')
                 or n.endswith('.md') or n.endswith('.bat') or n.endswith('.ps1')
                 or n.endswith('.env') or 'docker-compose' in n or 'Dockerfile.gpu' in n]
        assert not leaks, 'zip 含违禁条目: %s' % leaks
        zapp = set(n.split('/', 1)[1] for n in names
                   if n.startswith('app/') and n.endswith('.py'))
        zmissing = REQUIRED_MODULES - zapp
        assert not zmissing, 'zip 内 app/ 缺模块: %s' % sorted(zmissing)
        assert not any(n.startswith('tests/') for n in names), 'zip 含 tests/'
        # 包里的花色识别器必须就是当前工作区的最新源码。
        # 出现过「脚本改了、包没重打」→ 线上一直跑旧判定口径，且不报错、不异常。
        tool_rel = REQUIRED_TOOLS[0]
        tool_src = open(os.path.join(SRC, tool_rel), 'rb').read()
        assert zf.read(tool_rel) == tool_src, '包内 %s 不是最新源码' % tool_rel

    print('OK -> %s' % out)
    print('size: %.2f MB' % (os.path.getsize(out) / 1024.0 / 1024.0))
    tool_src = open(os.path.join(SRC, REQUIRED_TOOLS[0]), 'rb').read()
    print('pattern: %s  sha256=%s（与源码逐字节一致）'
          % (REQUIRED_TOOLS[0], hashlib.sha256(tool_src).hexdigest()[:16]))
    with zipfile.ZipFile(out) as zf:
        tools = [n for n in zf.namelist() if n.startswith('tools/') and n.endswith('.py')]
    print('tools:   %d 个脚本已进包' % len(tools))
    print('entries:')
    with zipfile.ZipFile(out) as zf:
        for info in sorted(zf.infolist(), key=lambda i: i.filename):
            print('  %12s  %s' % (format(info.file_size, ','), info.filename))
    shutil.rmtree(stage, ignore_errors=True)


if __name__ == '__main__':
    main()
