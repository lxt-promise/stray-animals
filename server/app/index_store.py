"""特征库门面：按 config.INDEX_BACKEND 分发到具体后端，对外接口六个方法保持不变。

    INDEX_BACKEND=sqlite   本地 SQLite 文件（默认，开发/测试/单机用）
    INDEX_BACKEND=cos      腾讯云 COS 对象存储（云托管等无持久盘环境用）

main.py 只依赖本模块的 put/get/ids/load/count/clear，
换后端、甚至换存储格式，上层零改动。
"""
from __future__ import annotations

from . import config

_backend_name = (config.INDEX_BACKEND or "sqlite").strip().lower()

if _backend_name == "sqlite":
    from . import sqlite_store as _backend
elif _backend_name == "cos":
    from . import cos_store as _backend
else:
    raise RuntimeError(
        f"未知 INDEX_BACKEND={config.INDEX_BACKEND!r}（可选值：sqlite / cos）"
    )

put = _backend.put
get = _backend.get
delete = _backend.delete
ids = _backend.ids
load = _backend.load
count = _backend.count
clear = _backend.clear

# 当前生效的后端名（cos_store / sqlite_store），/health 会带出去 ——
# 部署后一眼确认「到底切没切到 COS」，避免以为在用 COS 实际还是本地文件
BACKEND_NAME = _backend.__name__.rsplit(".", 1)[-1]
