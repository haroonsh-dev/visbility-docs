"""
Settings router - Receives provider configurations from the API gateway
and manages multi-provider support with fallback logic.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from ..services.provider_manager import provider_manager

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


class ProviderUpdateBody(BaseModel):
    provider: str = Field(..., min_length=1)
    apiKey: str = Field(..., min_length=8)
    model: Optional[str] = ""
    baseUrl: Optional[str] = ""


class ProviderDeleteBody(BaseModel):
    provider: str = Field(..., min_length=1)


@router.get("/providers")
async def list_providers():
    """List all configured providers and their status."""
    return {
        "success": True,
        "data": provider_manager.get_config_summary(),
    }


@router.post("/providers")
async def update_provider(body: ProviderUpdateBody):
    """Add or update a provider configuration."""
    valid_providers = ["groq", "openai", "gemini", "anthropic", "custom"]
    if body.provider not in valid_providers:
        raise HTTPException(status_code=400, detail=f"Invalid provider. Must be one of: {valid_providers}")

    provider_manager.set_provider(
        provider=body.provider,
        api_key=body.apiKey,
        model=body.model or "",
        base_url=body.baseUrl or "",
    )

    if body.provider == "groq":
        try:
            from ..services.groq_service import groq_service
            from ..services.conversation_service import conversation_service
            groq_service.reconfigure(body.apiKey)
            conversation_service.reconfigure(body.apiKey)
        except Exception as e:
            print(f"[SETTINGS] Warning reconfiguring Services: {e}")

    return {
        "success": True,
        "message": f"Provider {body.provider} configured successfully",
        "data": provider_manager.get_config_summary(),
    }


@router.delete("/providers/{provider}")
async def remove_provider(provider: str):
    """Remove a provider configuration."""
    provider_manager.remove_provider(provider)
    return {
        "success": True,
        "message": f"Provider {provider} removed",
        "data": provider_manager.get_config_summary(),
    }


@router.get("/providers/primary")
async def get_primary():
    """Get the primary (currently active) provider."""
    primary = provider_manager.get_primary_provider()
    if not primary:
        return {"success": True, "data": {"provider": None, "message": "No providers configured"}}
    return {
        "success": True,
        "data": {
            "provider": primary.provider,
            "model": primary.model,
            "base_url": primary.base_url,
        },
    }
