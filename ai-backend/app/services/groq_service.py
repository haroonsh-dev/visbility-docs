import os
import json
import re
import logging
import httpx
from groq import Groq, RateLimitError, APIStatusError
from ..config import settings
from . import groq_limit_state
from .provider_manager import provider_manager

logger = logging.getLogger(__name__)


class GroqRateLimitExceeded(Exception):
    """Raised when Groq daily/request token budget is exhausted."""

    def __init__(self, message: str, status: dict | None = None):
        super().__init__(message)
        self.status = status or groq_limit_state.status_payload()


class GroqService:
    def __init__(self):
        self.client = None
        self.model = "llama-3.3-70b-versatile"
        self.vision_models = [
            "qwen/qwen3.6-27b",
        ]
        self._vision_model_idx = 0
        self.available = False
        self.vision_available = True
        self._current_key = ""
        # Only use key configured via AI Settings (provider_manager)
        groq_config = provider_manager.get_provider("groq")
        key = groq_config.api_key if groq_config else ""
        self._configure(key)

    def _sync_with_provider_manager(self):
        """Ensure groq_service is using the latest runtime key configured in AI Settings."""
        groq_cfg = provider_manager.get_provider("groq")
        key = (groq_cfg.api_key if groq_cfg else "").strip()
        if key and key != getattr(self, "_current_key", ""):
            self._configure(key)

    def _configure(self, api_key: str):
        key = (api_key or "").strip()
        placeholders = {"", "gsk_your_groq_api_key", "gsk_your_groq_key_here", "your-api-key-here"}
        # Groq keys start with gsk_; reject Gemini/OpenAI/placeholder keys
        invalid = (
            not key
            or key in placeholders
            or key.startswith("gsk_your_")
            or key.startswith("AIza")  # Google
            or key.startswith("sk-ant-")  # Anthropic mistaken as Groq
            or (key.startswith("sk-") and not key.startswith("gsk_"))  # OpenAI
        )
        if invalid:
            self.client = None
            self.available = False
            self._current_key = ""
            return

        self.client = Groq(api_key=key, timeout=httpx.Timeout(15.0), max_retries=0)
        self.available = True
        self.vision_available = True
        self._current_key = key
        settings.GROQ_API_KEY = key

    def reconfigure(self, api_key: str) -> bool:
        provider_manager.set_provider("groq", api_key)
        self._configure(api_key)
        if self.available:
            groq_limit_state.clear_limit()
            try:
                from .conversation_service import conversation_service
                conversation_service.reconfigure(api_key)
            except Exception as e:
                print(f"[GROQ SERVICE] Warning sync with conversation_service: {e}")
        return self.available

    def _raise_if_locked(self):
        if groq_limit_state.is_limited():
            status = groq_limit_state.status_payload()
            raise GroqRateLimitExceeded(
                status.get("message")
                or "Groq rate limit active. Enter a new API key or wait for the timer.",
                status=status,
            )

    def _handle_rate_limit(self, e: Exception, model: str | None = None):
        msg = str(e)
        status = groq_limit_state.mark_limited(msg, model=model or self.model)
        raise GroqRateLimitExceeded(msg, status=status) from e

    def _chat_via_config(
        self,
        cfg,
        messages: list[dict],
        temperature: float,
        max_tokens: int,
        model_override: str | None = None,
    ) -> str:
        """Call one provider config (OpenAI-compatible or Groq SDK)."""
        from openai import OpenAI

        model = (model_override or cfg.model or "").strip()
        if cfg.provider == "groq":
            self._sync_with_provider_manager()
            self._raise_if_locked()
            if not self.available:
                raise RuntimeError("Groq not configured")
            use_model = model or self.model
            response = self.client.chat.completions.create(
                model=use_model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            return _strip_think_tags(response.choices[0].message.content or "")

        if cfg.provider == "gemini":
            base_url = "https://generativelanguage.googleapis.com/v1beta/openai/"
            client = OpenAI(api_key=cfg.api_key, base_url=base_url, timeout=120)
            use_model = model or "gemini-2.0-flash"
        elif cfg.provider == "anthropic":
            # Anthropic via OpenAI-compatible gateway if base_url set; else skip
            base_url = (cfg.base_url or "").strip()
            if not base_url:
                raise RuntimeError("Anthropic requires an OpenAI-compatible base_url in Settings")
            client = OpenAI(api_key=cfg.api_key, base_url=base_url, timeout=120)
            use_model = model or "claude-3-5-sonnet-latest"
        else:
            # openai + custom (Mistral, Together, OpenRouter, etc.)
            base_url = (cfg.base_url or "https://api.openai.com/v1").rstrip("/")
            client = OpenAI(api_key=cfg.api_key, base_url=base_url, timeout=120)
            use_model = model or "gpt-4o"

        response = client.chat.completions.create(
            model=use_model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return _strip_think_tags(response.choices[0].message.content or "")

    def chat_with_active_providers(
        self,
        messages: list[dict],
        temperature: float = 0.1,
        max_tokens: int = 4096,
        *,
        prefer_fast_groq: bool = False,
    ) -> str:
        """
        Use the provider selected in AI Settings (primary first), not hardcoded Groq models.
        Mistral as Custom + primary → Mistral model/base URL is used for extraction/classify.
        """
        self._sync_with_provider_manager()
        providers = provider_manager.get_active_providers()
        if not providers:
            return self.chat(messages, temperature=temperature, max_tokens=max_tokens)

        errors: list[str] = []
        for cfg in providers:
            try:
                if cfg.provider == "groq" and prefer_fast_groq:
                    try:
                        return self._chat_via_config(
                            cfg, messages, temperature, max_tokens, "llama-3.1-8b-instant"
                        )
                    except Exception as fast_err:
                        logger.warning(f"[chat_with_active] groq fast model failed: {fast_err}")
                        return self._chat_via_config(cfg, messages, temperature, max_tokens, None)

                text = self._chat_via_config(cfg, messages, temperature, max_tokens, None)
                logger.info(
                    f"[chat_with_active] ok provider={cfg.provider} model={cfg.model or 'default'}"
                )
                return text
            except Exception as e:
                err = f"{cfg.provider}/{cfg.model or '?'}: {e}"
                errors.append(err)
                logger.warning(f"[chat_with_active] failed {err}")
                continue

        raise RuntimeError(
            "All active AI providers failed for chat. "
            + ("; ".join(errors[:3]) if errors else "No providers configured.")
        )

    def _try_fallback(self, messages: list[dict], temperature: float, max_tokens: int, failed_provider: str) -> str | None:
        """
        Try the next available provider as fallback when the primary fails.
        Returns the response content if successful, None if all providers exhausted.
        """
        fallback = provider_manager.get_fallback_provider(failed_provider)
        if not fallback or fallback.provider == failed_provider:
            return None

        try:
            return self._chat_via_config(fallback, messages, temperature, max_tokens)
        except Exception:
            return self._try_fallback(messages, temperature, max_tokens, fallback.provider)

    def chat(self, messages: list[dict], temperature: float = 0.1, max_tokens: int = 4096, model: str = None) -> str:
        self._sync_with_provider_manager()
        self._raise_if_locked()
        if not self.available:
            # Try fallback providers
            fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
            if fallback_result:
                return fallback_result
            return self._fallback_response(messages)
        use_model = model or self.model
        try:
            response = self.client.chat.completions.create(
                model=use_model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            raw = response.choices[0].message.content or ""
            return _strip_think_tags(raw)
        except RateLimitError as e:
            # Try fallback before raising
            fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
            if fallback_result:
                return fallback_result
            self._handle_rate_limit(e, use_model)
        except APIStatusError as e:
            status_code = getattr(e, "status_code", None)
            err_msg = str(e).lower()
            # Also fall back on missing/retired Groq models (404 model_not_found)
            if (
                status_code in (404, 413, 429)
                or "rate" in err_msg
                or "too large" in err_msg
                or "limit" in err_msg
                or "tpm" in err_msg
                or "model_not_found" in err_msg
                or "does not exist" in err_msg
            ):
                fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
                if fallback_result:
                    return fallback_result
                if status_code in (413, 429) or "rate" in err_msg or "limit" in err_msg or "tpm" in err_msg:
                    self._handle_rate_limit(e, use_model)
            raise

    def chat_vision(self, messages: list[dict], temperature: float = 0.1, max_tokens: int = 4096) -> str:
        self._sync_with_provider_manager()
        self._raise_if_locked()
        if not self.available or not self.vision_available:
            fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
            if fallback_result:
                return fallback_result
            return self._fallback_response(messages)

        errors = []
        for i in range(self._vision_model_idx, len(self.vision_models)):
            model = self.vision_models[i]
            try:
                response = self.client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
                self._vision_model_idx = i
                raw = response.choices[0].message.content or ""
                return _strip_think_tags(raw)
            except RateLimitError as e:
                # Immediately raise — let caller fall back to fast local OCR
                logger.warning(f"Groq vision rate limited on {model} — skipping fallback, raising immediately")
                self._handle_rate_limit(e, model)
            except APIStatusError as e:
                if getattr(e, "status_code", None) == 429 or "rate_limit" in str(e).lower():
                    logger.warning(f"Groq vision rate limited on {model} — skipping fallback, raising immediately")
                    self._handle_rate_limit(e, model)
                err = str(e).lower()
                errors.append(f"{model}: {e}")
                if "does not support image" in err or "cannot read" in err or "decommissioned" in err or "not found" in err:
                    continue
                raise
            except Exception as e:
                err = str(e).lower()
                errors.append(f"{model}: {e}")
                if "429" in err or "rate_limit" in err:
                    logger.warning(f"Groq vision rate limited on {model} — skipping fallback, raising immediately")
                    self._handle_rate_limit(e, model)
                if "does not support image" in err or "cannot read" in err or "decommissioned" in err or "not found" in err:
                    continue
                raise

        self.vision_available = False
        fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
        if fallback_result:
            return fallback_result
        return self._fallback_response(messages)

    def _fallback_response(self, messages: list[dict]) -> str:
        last = messages[-1]["content"] if messages else ""
        if isinstance(last, list):
            texts = [c["text"] for c in last if isinstance(c, dict) and c.get("type") == "text"]
            last = " ".join(texts)
        return f"[AI API not configured. Please add an API key in Settings > AI Providers]\n\nReceived: {str(last)[:200]}"

    def _parse_json(self, text: str, default: dict) -> dict:
        try:
            json_match = re.search(r'\{.*\}', text, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
            return default
        except (json.JSONDecodeError, Exception):
            return default


def _strip_think_tags(text: str) -> str:
    if not text:
        return ""
    # Remove all <think>...</think> blocks
    cleaned = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
    if "</think>" in cleaned:
        cleaned = cleaned.split("</think>")[-1]

    cleaned = cleaned.strip()
    # Strip untagged reasoning monologue before actual Markdown table or heading
    first_table = cleaned.find("|")
    first_header = cleaned.find("#")
    
    starts = [pos for pos in (first_table, first_header) if pos != -1]
    if starts:
        min_start = min(starts)
        if min_start > 0:
            cleaned = cleaned[min_start:]

    return cleaned.strip()


groq_service = GroqService()
