#!/usr/bin/env python3
"""批量建库客户端。

用法：
    python tools/build_index.py --server https://ai.yourdomain.com --token xxx cats.json

cats.json 格式（照片必须是可直接下载的 https 链接，不能是微信云存储 fileId）：
    [
      {"id": "cat001", "name": "橘座", "schoolId": "sch001",
       "photos": ["https://xxx.tcb.qcloud.la/cat1.jpg", "..."]}
    ]

> fileId 无法在外部网络下载。最省事的做法是在小程序端新增一个管理员入口，
> 由云函数把档案照批量换成临时 URL 后直接调用服务端的 /v1/index/build。
"""
import argparse
import json
import sys

import httpx


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--server", default="http://127.0.0.1:8000")
    p.add_argument("--token", default="")
    p.add_argument("--school", default="")
    p.add_argument("json_file")
    a = p.parse_args()

    cats = json.loads(open(a.json_file, encoding="utf-8").read())
    if not isinstance(cats, list):
        sys.exit("JSON 根节点必须是数组")

    headers = {"Authorization": f"Bearer {a.token}"} if a.token else {}
    r = httpx.post(
        f"{a.server.rstrip('/')}/v1/index/build",
        json={"schoolId": a.school, "cats": cats, "photosPerCat": 6},
        headers=headers,
        timeout=600,
    )
    r.raise_for_status()
    print(json.dumps(r.json(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
