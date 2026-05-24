"""PostgreSQL bağlantısı (.env ile Node ile aynı değişkenler)."""

from __future__ import annotations

import os
from datetime import date, datetime
from decimal import Decimal

import psycopg
from psycopg.rows import dict_row


def _conninfo():
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        return database_url
    host = os.environ.get("DB_HOST", "127.0.0.1")
    port = os.environ.get("DB_PORT", "5432")
    db = os.environ.get("DB_NAME", "voyagestars")
    user = os.environ.get("DB_USER", "postgres")
    password = os.environ.get("DB_PASSWORD", "postgres")
    return f"host={host} port={port} dbname={db} user={user} password={password}"


def conn():
    """Her istek için kısa ömürlü bağlantı (dashboard düşük hacim)."""
    return psycopg.connect(_conninfo())


def jsonable_scalar(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return v


def dict_jsonable(row):
    if row is None:
        return None
    return {k: jsonable_scalar(v) for k, v in row.items()}


def fetch_all(sql: str, params: tuple | list | dict | None = None):
    with conn() as c:
        with c.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params or ())
            return [dict_jsonable(r) for r in cur.fetchall()]


def fetch_one(sql: str, params: tuple | list | dict | None = None):
    with conn() as c:
        with c.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params or ())
            return dict_jsonable(cur.fetchone())


def execute(sql: str, params: tuple | list | dict | None = None):
    with conn() as c:
        with c.cursor() as cur:
            cur.execute(sql, params or ())
            c.commit()
            return cur.rowcount


def execute_returning(sql: str, params: tuple | list | dict | None = None):
    with conn() as c:
        with c.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params or ())
            rows = [dict_jsonable(r) for r in cur.fetchall()]
            c.commit()
            return rows


def transaction():
    """with transaction() as cur: ..."""
    return _Transaction()


class _Transaction:
    def __enter__(self):
        self._conn = conn()
        self._cur = self._conn.cursor(row_factory=dict_row)
        return self._cur

    def __exit__(self, exc_type, exc, tb):
        if exc_type:
            self._conn.rollback()
        else:
            self._conn.commit()
        self._cur.close()
        self._conn.close()
