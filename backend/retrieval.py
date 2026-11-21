import numpy as np

from database import connect

SEARCH_SQL = """SELECT id, chunk_id, content, 1 - (embedding <=> %(q)s) AS similarity
FROM chunks
ORDER BY embedding <=> %(q)s
LIMIT %(k)s"""

MIN_POINTS_FOR_PCA = 3


def search(query_vector: list[float], top_k: int) -> list[dict]:
    q = np.array(query_vector, dtype=np.float32)
    with connect() as conn:
        rows = conn.execute(SEARCH_SQL, {"q": q, "k": top_k}).fetchall()
    return [
        {
            "rank": i + 1,
            "id": r[0],
            "chunk_id": r[1],
            "text": r[2],
            "char_count": len(r[2]),
            "similarity": round(float(r[3]), 4),
        }
        for i, r in enumerate(rows)
    ]


def project_2d(vectors: list[list[float]], query_vector: list[float] | None = None) -> dict:
    if len(vectors) < MIN_POINTS_FOR_PCA:
        return {
            "available": False,
            "reason": f"PCA needs at least {MIN_POINTS_FOR_PCA} chunks to draw a meaningful map. "
            f"This document produced {len(vectors)}. Try a longer text or a smaller chunk size.",
        }

    matrix = np.array(vectors, dtype=np.float64)
    mean = matrix.mean(axis=0)
    centered = matrix - mean
    _, singular_values, components = np.linalg.svd(centered, full_matrices=False)
    basis = components[:2]
    variance = singular_values**2
    explained = (variance[:2] / variance.sum()).tolist() if variance.sum() > 0 else [0.0, 0.0]

    points = centered @ basis.T
    result = {
        "available": True,
        "points": points.round(5).tolist(),
        "explained_variance": [round(v, 4) for v in explained],
        "query_point": None,
    }
    if query_vector is not None:
        q = (np.array(query_vector, dtype=np.float64) - mean) @ basis.T
        result["query_point"] = q.round(5).tolist()
    return result
