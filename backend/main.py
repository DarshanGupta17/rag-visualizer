import hashlib
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

import database
import embeddings
import retrieval
from chunking import chunk_text

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rag-visualizer")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
MAX_DOCUMENT_CHARS = 60_000
MAX_CHUNKS = 400


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Loading embedding model %s", embeddings.MODEL_NAME)
    started = time.perf_counter()
    embeddings.load_model()
    log.info("Model ready in %.1fs (%d dimensions)", time.perf_counter() - started, embeddings.dimensions())
    database.wait_for_database()
    log.info("PostgreSQL with pgvector is ready")
    yield


app = FastAPI(title="RAG Visualizer", lifespan=lifespan)


class ProcessRequest(BaseModel):
    text: str
    chunk_size: int = Field(300, ge=50, le=2000)
    chunk_overlap: int = Field(50, ge=0, le=1000)

    @model_validator(mode="after")
    def check(self):
        if not self.text.strip():
            raise ValueError("Document is empty. Paste some text first.")
        if len(self.text) > MAX_DOCUMENT_CHARS:
            raise ValueError(f"Document is too long for this demo (max {MAX_DOCUMENT_CHARS:,} characters).")
        if self.chunk_overlap >= self.chunk_size:
            raise ValueError("Chunk overlap must be smaller than chunk size.")
        return self


class SearchRequest(BaseModel):
    query: str = Field(..., max_length=1000)
    top_k: int = Field(3, ge=1, le=10)

    @model_validator(mode="after")
    def check(self):
        if not self.query.strip():
            raise ValueError("Question is empty.")
        return self


def ms(since: float) -> float:
    return round((time.perf_counter() - since) * 1000, 1)


def model_info() -> dict:
    return {"name": embeddings.MODEL_NAME, "dimensions": embeddings.dimensions(), "device": "cpu"}


@app.exception_handler(Exception)
async def unhandled(_, error: Exception):
    log.exception("Unhandled error")
    return JSONResponse(status_code=500, content={"detail": f"Server error: {error}"})


@app.get("/api/health")
def health():
    return {"model_loaded": embeddings.is_loaded(), "model": model_info(), "database": database.is_connected()}


@app.post("/api/process")
def process(req: ProcessRequest):
    text = req.text.strip()

    started = time.perf_counter()
    chunks = chunk_text(text, req.chunk_size, req.chunk_overlap)
    chunk_ms = ms(started)
    if len(chunks) > MAX_CHUNKS:
        raise HTTPException(400, f"That would create {len(chunks)} chunks. Increase the chunk size (max {MAX_CHUNKS}).")

    fingerprint = f"{embeddings.MODEL_NAME}|{req.chunk_size}|{req.chunk_overlap}|{text}"
    document_hash = hashlib.sha256(fingerprint.encode()).hexdigest()

    try:
        duplicate = database.stored_hash() == document_hash
    except Exception as error:
        raise HTTPException(503, f"Database unavailable: {error}")

    if duplicate:
        embed_ms = store_ms = 0.0
        replaced = 0
        stored = database.fetch_chunks()
    else:
        started = time.perf_counter()
        vectors = embeddings.embed_texts([c["text"] for c in chunks])
        embed_ms = ms(started)

        started = time.perf_counter()
        replaced = database.replace_chunks(chunks, vectors, document_hash)
        stored = database.fetch_chunks()
        store_ms = ms(started)

    return {
        "duplicate": duplicate,
        "replaced_rows": replaced,
        "document": text,
        "document_chars": len(text),
        "config": {"chunk_size": req.chunk_size, "chunk_overlap": req.chunk_overlap},
        "model": model_info(),
        "chunks": stored,
        "timings_ms": {"chunking": chunk_ms, "embedding": embed_ms, "storage": store_ms},
        "stats": database.stats(),
        "projection": retrieval.project_2d([c["embedding"] for c in stored]),
    }


@app.post("/api/search")
def search(req: SearchRequest):
    stored = database.fetch_chunks()
    if not stored:
        raise HTTPException(400, "The vector database is empty. Process a document first.")

    started = time.perf_counter()
    query_vector = embeddings.embed_query(req.query.strip())
    embed_ms = ms(started)

    started = time.perf_counter()
    results = retrieval.search(query_vector, req.top_k)
    search_ms = ms(started)

    return {
        "query": req.query.strip(),
        "top_k": req.top_k,
        "query_instruction": embeddings.QUERY_INSTRUCTION,
        "query_embedding": [round(x, 6) for x in query_vector],
        "results": results,
        "searched_rows": len(stored),
        "sql": retrieval.SEARCH_SQL,
        "timings_ms": {"query_embedding": embed_ms, "vector_search": search_ms},
        "projection": retrieval.project_2d([c["embedding"] for c in stored], query_vector),
    }


@app.get("/api/stats")
def stats():
    try:
        return database.stats()
    except Exception as error:
        return {"connected": False, "error": str(error), "total_chunks": 0, "total_vectors": 0, "dimensions": 0}


@app.get("/api/chunks")
def chunks(include_vectors: bool = True, with_projection: bool = False):
    stored = database.fetch_chunks(include_vectors or with_projection)
    response = {"chunks": stored}
    if with_projection:
        response["projection"] = retrieval.project_2d([c["embedding"] for c in stored])
    return response


@app.delete("/api/reset")
def reset():
    return {"deleted_rows": database.clear(), "stats": database.stats()}


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
