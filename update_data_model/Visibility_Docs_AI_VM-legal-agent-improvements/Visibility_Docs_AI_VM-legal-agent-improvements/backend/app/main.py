import os
os.environ["USE_SHARED_MEMORY"] = "0"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"

import logging
import traceback
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.exceptions import RequestValidationError
from .routers import documents, search, chat, auth, reports
from .auth_deps import get_current_user, get_optional_user
from fastapi import Depends
from .config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("visibility-docs")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        if settings.DATABASE_URL:
            from .init_supabase import init_supabase_schema
            init_supabase_schema(settings.DATABASE_URL)
        from .database import _get_supabase
        _get_supabase()
        # Load embedding model FIRST (before PaddleOCR) to avoid torch DLL conflict
        _warmup_embedding()
        logger.info("Startup complete")
    except Exception as e:
        logger.warning(f"Startup error (non-fatal): {e}")
    yield


def _warmup_embedding():
    try:
        from .services.embedding_service import embedding_service
        embedding_service.load()
        logger.info("Embedding model loaded")
    except Exception as e:
        logger.warning(f"Embedding model warmup failed (will skip embeddings): {e}")


app = FastAPI(
    title="Visibility Docs AI",
    description="Enterprise Document Intelligence Platform",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_tags=[
        {"name": "documents", "description": "Upload, process, classify & extract document data"},
        {"name": "search", "description": "Hybrid semantic search across documents"},
        {"name": "chat", "description": "AI chat with document context (RAG)"},
    ],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def audit_middleware(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    response.headers["X-Response-Time-Ms"] = str(int((time.time() - start) * 1000))
    return response


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc):
    return JSONResponse(status_code=422, content={"detail": str(exc.errors())})


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc):
    logger.error(f"Unhandled error on {request.method} {request.url.path}: {exc}\n{traceback.format_exc()}")
    return JSONResponse(status_code=500, content={"detail": f"Internal server error: {str(exc)}"})


app.include_router(auth.router)
app.include_router(documents.router, dependencies=[Depends(get_optional_user)])
app.include_router(search.router, dependencies=[Depends(get_optional_user)])
app.include_router(chat.router, dependencies=[Depends(get_optional_user)])
app.include_router(reports.router, dependencies=[Depends(get_current_user)])


@app.get("/", tags=["status"])
async def root():
    return {
        "service": "Visibility Docs AI",
        "version": "1.0.0",
        "status": "running",
        "docs": "/docs",
        "openapi": "/openapi.json",
        "endpoints": {
            "upload": "POST /api/v1/documents/upload",
            "process": "POST /api/v1/documents/{id}/process",
            "documents": "GET /api/v1/documents",
            "classify": "POST /api/v1/documents/classify-text",
            "extract": "POST /api/v1/documents/extract-entities",
            "search": "POST /api/v1/search",
            "chat": "POST /api/v1/chat",
            "chat_all": "POST /api/v1/chat/all",
            "similar": "GET /api/v1/search/similar/{id}",
            "by_type": "GET /api/v1/search/by-type/{type}",
            "validate": "POST /api/v1/documents/{id}/validate",
            "workflow": "GET /api/v1/documents/{id}/workflow",
            "approve": "POST /api/v1/documents/{id}/workflow/approve",
            "reject": "POST /api/v1/documents/{id}/workflow/reject",
            "pending_approvals": "GET /api/v1/documents/workflows/pending",
            "validations_list": "GET /api/v1/documents/validations/list",
            "job_status": "GET /api/v1/documents/{id}/job",
            "dashboard_stats": "GET /api/v1/dashboard/stats",
        },
    }


@app.get("/health", tags=["status"])
async def health():
    from .database import _get_supabase, _use_supabase
    _get_supabase()
    db_status = "supabase" if _use_supabase else "local-sqlite"
    return {
        "status": "healthy",
        "database": db_status,
        "groq_api": settings.GROQ_API_KEY[:8] + "..." if settings.GROQ_API_KEY and settings.GROQ_API_KEY != "gsk_your_groq_api_key" else "not configured",
    }


@app.get("/api/v1/dashboard/stats", tags=["status"])
async def dashboard_stats(organization_id: str = "default-org"):
    from .database import _get_supabase, _use_supabase, _get_local_db
    try:
        client = _get_supabase()
        if _use_supabase and client:
            total = len(getattr(client.table("documents").select("id", count="exact").eq("organization_id", organization_id).execute(), "data", []))
            processed = len(getattr(client.table("documents").select("id", count="exact").eq("organization_id", organization_id).eq("status", "processed").execute(), "data", []))
            failed = len(getattr(client.table("documents").select("id", count="exact").eq("organization_id", organization_id).eq("status", "failed").execute(), "data", []))
            pending_approvals = len(getattr(client.table("workflow_instances").select("id", count="exact").eq("organization_id", organization_id).eq("status", "active").execute(), "data", []))
            return {"total_documents": total, "processed": processed, "failed": failed, "pending": total - processed - failed, "by_type": {}, "pending_approvals": pending_approvals}
    except Exception:
        pass
    conn = _get_local_db()
    total = conn.execute("SELECT COUNT(*) FROM documents WHERE organization_id=?", (organization_id,)).fetchone()[0]
    processed = conn.execute("SELECT COUNT(*) FROM documents WHERE organization_id=? AND status='processed'", (organization_id,)).fetchone()[0]
    failed = conn.execute("SELECT COUNT(*) FROM documents WHERE organization_id=? AND status='failed'", (organization_id,)).fetchone()[0]
    pending_approvals = conn.execute("SELECT COUNT(*) FROM workflow_instances WHERE organization_id=? AND status='active'", (organization_id,)).fetchone()[0]
    return {
        "total_documents": total,
        "processed": processed,
        "failed": failed,
        "pending": total - processed - failed,
        "by_type": {},
        "pending_approvals": pending_approvals,
    }
