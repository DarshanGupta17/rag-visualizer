import os
import time

import numpy as np
import psycopg
from pgvector.psycopg import register_vector

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://rag:rag@localhost:5432/rag")

ENSURE_SCHEMA = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS chunks (
    id SERIAL PRIMARY KEY,
    chunk_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    start_char INTEGER NOT NULL,
    end_char INTEGER NOT NULL,
    embedding VECTOR(384) NOT NULL,
    document_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def connect() -> psycopg.Connection:
    conn = psycopg.connect(DATABASE_URL, connect_timeout=5)
    register_vector(conn)
    return conn


def ensure_schema() -> None:
    with connect() as conn:
        conn.execute(ENSURE_SCHEMA)
        conn.commit()


def wait_for_database(attempts: int = 30, delay: float = 2.0) -> None:
    last_error = None
    for _ in range(attempts):
        try:
            ensure_schema()
            with connect() as conn:
                conn.execute("SELECT 1 FROM chunks LIMIT 1")
            return
        except Exception as error:
            last_error = error
            time.sleep(delay)
    raise RuntimeError(f"Database not reachable: {last_error}")


def is_connected() -> bool:
    try:
        with connect() as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        return False


def stored_hash() -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT document_hash FROM chunks LIMIT 1").fetchone()
    return row[0] if row else None


def replace_chunks(chunks: list[dict], vectors: list[list[float]], document_hash: str) -> int:
    with connect() as conn:
        with conn.transaction():
            removed = conn.execute("DELETE FROM chunks").rowcount
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO chunks (chunk_id, content, start_char, end_char, embedding, document_hash) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    [
                        (c["chunk_id"], c["text"], c["start"], c["end"], np.array(v, dtype=np.float32), document_hash)
                        for c, v in zip(chunks, vectors)
                    ],
                )
    return removed


def fetch_chunks(include_vectors: bool = True) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, chunk_id, content, start_char, end_char, embedding, created_at FROM chunks ORDER BY chunk_id"
        ).fetchall()
    return [
        {
            "id": r[0],
            "chunk_id": r[1],
            "text": r[2],
            "start": r[3],
            "end": r[4],
            "char_count": len(r[2]),
            "embedding": [round(float(x), 6) for x in r[5]] if include_vectors else None,
            "created_at": r[6].isoformat(),
        }
        for r in rows
    ]


def stats() -> dict:
    with connect() as conn:
        count, vectors, dims = conn.execute(
            "SELECT COUNT(*), COUNT(embedding), MAX(vector_dims(embedding)) FROM chunks"
        ).fetchone()
        extension = conn.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'").fetchone()
        size = conn.execute("SELECT pg_size_pretty(pg_total_relation_size('chunks'))").fetchone()[0]
    return {
        "connected": True,
        "total_chunks": count,
        "total_vectors": vectors,
        "dimensions": dims or 0,
        "pgvector_version": extension[0] if extension else None,
        "table_size": size,
    }


def clear() -> int:
    with connect() as conn:
        return conn.execute("DELETE FROM chunks").rowcount
