# -*- coding: utf-8 -*-
"""解压识别服务部署包，在「像容器一样干净」的目录里跑一次端到端识别。

为什么要有这一步：`package_vision.py` 只能证明「zip 生成成功、文件都在」，
证明不了「包里那套代码能跑」。真正会出事的是这一类：

  - 包里漏了某个模块（`attrs.py` 曾经就是新加的，而打包脚本按数量断言会直接挂）；
  - 包里的代码依赖了 `tests/` 或 `tools/` 里的东西（它们不进包）；
  - 只靠 `.env` 才成立的配置（`.env` 不进包，线上靠环境变量）。

所以这里把 zip 解到一个临时目录，**清除本地相关环境变量**，用子进程 cwd 指向
解压目录去 import 包里的 `app.main` —— 跑不通就说明这个包不能上传。

用法：
    python scripts/verify_vision_package.py                    # 自动取 dist/ 最新 zip
    python scripts/verify_vision_package.py dist/xxx.zip
"""
import glob
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, 'env', 'Scripts', 'python.exe')
CAT = os.path.join(ROOT, 'server', 'tests', 'fixtures', 'sample_cat.jpg')

# 这些变量在本地 .env / shell 里可能存在，验证前必须清掉，否则「本地配好了、
# 线上没配」这类问题会被验证过程掩盖（.env 不进包，线上只认 Dockerfile ENV + 控制台）。
STRIP_ENV = ('DETECT_ONNX', 'DETECT_AUTO', 'REID_ONNX', 'REID_SIZE',
             'INDEX_DB', 'INDEX_BACKEND', 'COS_', 'ATTR_API_URL', 'API_TOKEN')

PROBE = r'''
import json
import os
from PIL import Image
from app import engine, main as M, media, config

media.fetch_image = lambda u: Image.open(CAT_PATH).convert("RGB")
eng = engine.get_engine()

print("reid     %s" % config.REID_ONNX)
print("engine   provider=%s dim=%s size=%s" % (eng.provider, eng.dim, eng.embedder.size))
print("detector %s" % ("ON" if getattr(eng.detector, "sess", None) is not None else "OFF"))
print("attrs    %s" % eng.attr_source)

r = M.recognize(M.RecognizeReq(url="http://x/a.jpg", type="image", schoolId="s1"), None)
print("tags     " + " · ".join("%s=%s" % (t["k"], t["v"]) for t in r["features"]["tags"]))
print("crop     %s conf=%.2f boxes=%d" % (
    r["meta"].get("crop"), r["meta"].get("detectConf") or 0,
    r["meta"].get("detectCandidates") or 0))

# 候选条数冒烟：库里塞 6 只猫，返回的候选必须 ≤ TOP_N。
# 这一条是包级验证 —— 源码改了但没重新打包时，线上会一直用旧口径，
# 而单元测试测的是源码，测不出「包里是旧的」。
# pattern 留空：花色硬过滤（黑白系 × 橘/三花/玳瑁）会按查询花色剔除档案，
# 那样测到的是过滤而不是截断 —— 这里要验的是「库里有 4 只，候选只出 2 条」。
cats = [M.CatRef(id="c%d" % i, name="c%d" % i, pattern="",
                 photos=["http://x/%d.jpg" % i]) for i in range(6)]
# 先把 6 只全部补进库：识别热路径的补库上限是 2 只（BOOTSTRAP_LIMIT），
# 库里只有 2 只时「候选 2 条」是巧合，验不出截断。要验截断，库必须多于 2 只。
M.ensure_index(cats, "s2", limit=6)
r2 = M.recognize(M.RecognizeReq(url="http://x/a.jpg", type="image",
                                schoolId="s2", cats=cats), None)
n = len(r2["candidates"])
print("cands    %d / 库 %d 只（TOP_N=%d）" % (n, r2["meta"].get("indexed"), config.TOP_N))
# 库里有 6 只、候选只有 2 条，才是真的验到截断
if n > config.TOP_N:
    raise SystemExit("候选条数超过 TOP_N：包内代码与预期不一致")
indexed = int(r2["meta"].get("indexed") or 0)
if indexed <= config.TOP_N:
    raise SystemExit("库里只有 %d 只猫，这条冒烟验不到截断（应 > TOP_N）" % indexed)

# 缓存冒烟：同一个素材连续两次，第二次必须命中缓存。
# 这是「视频不再被反复计算」的包级证据 —— 源码里有缓存、但包是旧的，
# 线上照样一分钟算 10 次，而单元测试测的是源码，测不出包没更新。
r3 = M.recognize(M.RecognizeReq(url="http://x/a.jpg", type="image", schoolId="s3"), None)
r4 = M.recognize(M.RecognizeReq(url="http://x/a.jpg", type="image", schoolId="s3"), None)
print("cache    first=%s second=%s" % (r3["meta"].get("cached"), r4["meta"].get("cached")))
if r4["meta"].get("cached") is not True:
    raise SystemExit("第二次识别未命中缓存：包内代码与预期不一致（视频会被反复计算）")
print("timing   " + json.dumps(r["meta"].get("timing") or {}, ensure_ascii=False))
print("indexed  %s backend=%s" % (r["meta"].get("indexed"), r["meta"].get("indexBackend")))
'''.replace('CAT_PATH', repr(CAT))


def pick_zip(argv):
    if len(argv) > 1:
        return os.path.abspath(argv[1])
    found = sorted(glob.glob(os.path.join(ROOT, 'dist', 'catcampus-vision-*.zip')))
    if not found:
        raise SystemExit('dist/ 下没有 catcampus-vision-*.zip，先跑 scripts/package_vision.py')
    return found[-1]


def main():
    path = pick_zip(sys.argv)
    stage = tempfile.mkdtemp(prefix='catcampus-verify-')
    print('包      %s' % path)
    print('大小    %.2f MB' % (os.path.getsize(path) / 1024.0 / 1024.0))
    print('解压到  %s' % stage)

    try:
        with zipfile.ZipFile(path) as zf:
            zf.extractall(stage)

        env = dict(os.environ)
        for k in list(env):
            if any(k == s or (s.endswith('_') and k.startswith(s)) for s in STRIP_ENV):
                env.pop(k, None)
        env['PYTHONPATH'] = stage          # 确保 import 的是解压出来的那份
        env['PYTHONDONTWRITEBYTECODE'] = '1'

        # 模拟 Dockerfile 的 ENV —— 容器里是 /app/...，这里映射到解压目录。
        # 这步不能省：REID_ONNX 默认为空，不注入就会退化成 hash 占位引擎，
        # 于是「包里的 reid.onnx 损坏 / 没打进去」这种致命问题被验证过程掩盖。
        os.makedirs(os.path.join(stage, 'data'), exist_ok=True)
        env.update({
            'REID_ONNX': os.path.join(stage, 'models', 'reid.onnx'),
            'REID_SIZE': '224',
            'INDEX_DB': os.path.join(stage, 'data', 'index.sqlite3'),
            'FETCH_TIMEOUT': '20',
            'MAX_FRAMES': '8',
            # DETECT_ONNX 不设：与容器一致，走 DETECT_AUTO 自动发现
        })

        p = subprocess.run([PY, '-c', PROBE], cwd=stage, env=env,
                           capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
        out = (p.stdout or '').strip()
        err = (p.stderr or '').strip()
        if out:
            print('-' * 52)
            print(out)
        if p.returncode != 0:
            print('-' * 52)
            print('验证失败（退出码 %d）' % p.returncode)
            if err:
                print(err[-2500:])
            return 1

        # 两条硬门槛，对应两类「不报错但线上废掉」的事故：
        #   ① provider=hash → 包里 reid.onnx 没用上，特征全随机，建库照跑、识别全错；
        #   ② detector OFF  → 检测没生效，退化成整图提特征，表现就是「识别不准」。
        problems = []
        if 'provider=hash' in out:
            problems.append('特征引擎退化成了 hash 占位（reid.onnx 没加载上）')
        if 'detector ON' not in out:
            problems.append('检测模型没加载（models/yolov8n.onnx 在包里但引擎没用上）')
        if problems:
            print('-' * 52)
            for x in problems:
                print('❌ ' + x)
            if err:
                print(err[-1200:])
            return 2
        print('-' * 52)
        print('OK：包内代码可独立运行，特征引擎与检测模型均已加载')
        return 0
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
