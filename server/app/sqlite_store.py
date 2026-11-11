"""本地特征库（SQLite 后端）：把每只猫的照片变成向量后持久化，避免每次识别都重新下载、重新算。

用标准库 sqlite 即可 —— 几百只猫 × 每条 4KB 向量，全表也就几 MB，
全量载入内存做矩阵乘比接一套向量数据库划算得多。

适用场景：本地开发 / 测试 / 单机部署。云端（云托管）无持久盘，用 cos_store 后端。
接口契约与 cos_store 完全一致（由 index_store 门面统一分发）。
"""
from __future__ import annotations

import sqlite3
import time
from typing import Dict, List, Optional

import numpy as np

from . import config


def _conn() -> sqlite3.Connection:
    config.INDEX_DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(config.INDEX_DB), timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute(
        """CREATE TABLE IF NOT EXISTS cat_index (
             cat_id     TEXT PRIMARY KEY,
             school_id  TEXT,
             dim        INTEGER,
             embedding  BLOB,
             source     TEXT,
             updated_at REAL,
             version    INTEGER DEFAULT 0
           )"""
    )
    # 兼容旧库（没有 version 列时补上）；sqlite 的 ALTER TABLE 不支持 IF NOT EXISTS，
    # 用 try/except 吞掉「列已存在」。旧行 version=0，load 时会被当前版本过滤掉
    # （换骨干后必须重建，见 config.FEATURE_POOL_VERSION）。
    try:
        c.execute("ALTER TABLE cat_index ADD COLUMN version INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    return c


def put(cat_id: str, school_id: str, emb: np.ndarray, source: str = "recognize") -> None:
    c = _conn()
    try:
        c.execute(
            "INSERT INTO cat_index(cat_id,school_id,dim,embedding,source,updated_at,version) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(cat_id) DO UPDATE SET "
            "school_id=excluded.school_id,dim=excluded.dim,embedding=excluded.embedding,"
            "source=excluded.source,updated_at=excluded.updated_at,version=excluded.version",
            (cat_id, school_id or "", int(emb.shape[0]), emb.astype(np.float32).tobytes(),
             source, time.time(), int(config.FEATURE_POOL_VERSION)),
        )
        c.commit()
    finally:
        c.close()


def delete(cat_id: str) -> bool:
    """删掉一只猫的向量（删档案时必须调用，否则留下幽灵残留）。"""
    c = _conn()
    try:
        cur = c.execute("DELETE FROM cat_index WHERE cat_id=?", (cat_id,))
        c.commit()
        return cur.rowcount > 0
    finally:
        c.close()


def get(cat_id: str) -> Optional[np.ndarray]:
    c = _conn()
    try:
        r = c.execute(
            "SELECT embedding FROM cat_index WHERE cat_id=? AND version=?",
            (cat_id, int(config.FEATURE_POOL_VERSION)),
        ).fetchone()
        return np.frombuffer(r[0], dtype=np.float32) if r else None
    finally:
        c.close()


def ids(school_id: str = "") -> List[str]:
    c = _conn()
    ver = int(config.FEATURE_POOL_VERSION)
    try:
        if school_id:
            rows = c.execute(
                "SELECT cat_id FROM cat_index WHERE school_id=? AND version=?",
                (school_id, ver),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT cat_id FROM cat_index WHERE version=?", (ver,)
            ).fetchall()
        return [r[0] for r in rows]
    finally:
        c.close()


def load(school_id: str = "") -> Dict[str, np.ndarray]:
    """一次性取出某校区全部向量（仅当前 FEATURE_POOL_VERSION 的），供 numpy 批量矩阵乘。

    版本不符的向量（换骨干/归一化后残留的旧向量）直接跳过，绝不混算 ——
    同维不同义的向量做点积会产出看似正常实则全错的相似度。
    """
    c = _conn()
    ver = int(config.FEATURE_POOL_VERSION)
    try:
        if school_id:
            rows = c.execute(
                "SELECT cat_id,embedding FROM cat_index WHERE school_id=? AND version=?",
                (school_id, ver),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT cat_id,embedding FROM cat_index WHERE version=?", (ver,)
            ).fetchall()
        return {r[0]: np.frombuffer(r[1], dtype=np.float32) for r in rows}
    finally:
        c.close()


def count(school_id: str = "") -> int:
    return len(ids(school_id))


def clear(school_id: str = "") -> int:
    """清空特征库。

    school_id 为空时清空全部（用于「档案库即真相来源」的整体重建）；
    否则只清该校区。返回被删除的条数。
    """
    c = _conn()
    try:
        if school_id:
            cur = c.execute("DELETE FROM cat_index WHERE school_id=?", (school_id,))
        else:
            cur = c.execute("DELETE FROM cat_index")
        c.commit()
        return cur.rowcount
    finally:
        c.close()
