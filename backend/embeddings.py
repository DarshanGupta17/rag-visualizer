import os

from sentence_transformers import SentenceTransformer

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "

_model: SentenceTransformer | None = None


def load_model() -> SentenceTransformer:
    global _model
    if _model is None:
        try:
            _model = SentenceTransformer(MODEL_NAME, device="cpu", local_files_only=True)
        except Exception:
            _model = SentenceTransformer(MODEL_NAME, device="cpu")
    return _model


def is_loaded() -> bool:
    return _model is not None


def dimensions() -> int:
    return load_model().get_sentence_embedding_dimension()


def embed_texts(texts: list[str]) -> list[list[float]]:
    vectors = load_model().encode(texts, normalize_embeddings=True, batch_size=32)
    return vectors.tolist()


def embed_query(query: str) -> list[float]:
    vector = load_model().encode(QUERY_INSTRUCTION + query, normalize_embeddings=True)
    return vector.tolist()
