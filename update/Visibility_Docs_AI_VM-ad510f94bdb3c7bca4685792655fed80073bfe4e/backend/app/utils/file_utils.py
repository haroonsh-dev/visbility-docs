import uuid
import hashlib
import re
from pathlib import Path
from fastapi import UploadFile
from ..config import settings
from ..database import SupabaseDB
from ..services.hf_storage import hf_storage

ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".webp", ".docx", ".xlsx", ".pptx", ".txt"}
MAX_FILE_SIZE = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024


def is_allowed_file(filename: str) -> bool:
    ext = Path(filename).suffix.lower()
    return ext in ALLOWED_EXTENSIONS


def get_file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def generate_unique_filename(original: str) -> str:
    if not original:
        return f"file_{uuid.uuid4().hex[:8]}"
    safe = re.sub(r'[^a-zA-Z0-9._-]', '_', original)
    safe = safe.strip().strip('.')
    safe = safe[:200]
    if not safe:
        safe = f"file_{uuid.uuid4().hex[:8]}"
    return safe


async def save_upload_file(upload_file: UploadFile, organization_id: str = "") -> dict:
    file_data = await upload_file.read()

    if len(file_data) > MAX_FILE_SIZE:
        raise ValueError(f"File too large. Max size: {settings.MAX_UPLOAD_SIZE_MB}MB")

    filename = generate_unique_filename(upload_file.filename)
    remote_path = f"{organization_id}/{filename}" if organization_id else filename

    # Upload to HuggingFace
    hf_url = hf_storage.upload_bytes(file_data, remote_path)

    # Upload to Supabase storage
    supabase_url = ""
    try:
        SupabaseDB.upload_file("documents", remote_path, file_data, upload_file.content_type)
        supabase_url = f"{settings.SUPABASE_URL}/storage/v1/object/public/documents/{remote_path}"
    except Exception:
        pass

    return {
        "org_id": organization_id,
        "filename": remote_path,
        "original_name": upload_file.filename,
        "file_path": hf_url or supabase_url,
        "file_size": len(file_data),
        "file_hash": get_file_hash(file_data),
        "content_type": upload_file.content_type or "application/octet-stream",
        "supabase_url": supabase_url or hf_url,
    }
