import logging
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from .auth.service import decode_access_token
from .database import get_user_by_id

logger = logging.getLogger("visibility-docs")
security = HTTPBearer(auto_error=False)


async def get_current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = credentials.credentials
    payload = decode_access_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user_id = payload.get("sub")
    email = payload.get("email", "")
    org_id = payload.get("org_id", "")
    if not user_id or not org_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return {"user_id": user_id, "email": email, "org_id": org_id}


async def get_optional_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    if credentials is None:
        return None
    token = credentials.credentials
    payload = decode_access_token(token)
    if payload is None:
        return None
    user_id = payload.get("sub")
    org_id = payload.get("org_id", "default-org")
    email = payload.get("email", "")
    return {"user_id": user_id, "email": email, "org_id": org_id}
