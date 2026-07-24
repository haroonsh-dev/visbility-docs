import os
import json
import re
import httpx
from groq import Groq, RateLimitError, APIStatusError
from ..config import settings
from . import groq_limit_state
from .provider_manager import provider_manager


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
            "llama-3.2-90b-vision-preview",
        ]
        self._vision_model_idx = 0
        self.available = False
        self.vision_available = True
        # Only use key configured via AI Settings (provider_manager)
        groq_config = provider_manager.get_provider("groq")
        key = groq_config.api_key if groq_config else ""
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
            return

        self.client = Groq(api_key=key, timeout=httpx.Timeout(120.0))
        self.available = True
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

    def _try_fallback(self, messages: list[dict], temperature: float, max_tokens: int, failed_provider: str) -> str | None:
        """
        Try the next available provider as fallback when the primary fails.
        Returns the response content if successful, None if all providers exhausted.
        """
        fallback = provider_manager.get_fallback_provider(failed_provider)
        if not fallback or fallback.provider == failed_provider:
            return None

        try:
            from openai import OpenAI
            if fallback.provider == "groq":
                client = Groq(api_key=fallback.api_key, timeout=httpx.Timeout(120.0))
                model = fallback.model or self.model
                response = client.chat.completions.create(
                    model=model, messages=messages, temperature=temperature, max_tokens=max_tokens
                )
                return response.choices[0].message.content
            else:
                # OpenAI-compatible providers (openai, gemini, custom)
                base_url = fallback.base_url or "https://api.openai.com/v1"
                client = OpenAI(api_key=fallback.api_key, base_url=base_url, timeout=120)
                model = fallback.model or "gpt-4o"
                response = client.chat.completions.create(
                    model=model, messages=messages, temperature=temperature, max_tokens=max_tokens
                )
                return response.choices[0].message.content
        except Exception as e:
            # Try next fallback
            return self._try_fallback(messages, temperature, max_tokens, fallback.provider)

    def chat(self, messages: list[dict], temperature: float = 0.1, max_tokens: int = 4096, model: str = None) -> str:
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
            return response.choices[0].message.content
        except RateLimitError as e:
            # Try fallback before raising
            fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
            if fallback_result:
                return fallback_result
            self._handle_rate_limit(e, use_model)
        except APIStatusError as e:
            if getattr(e, "status_code", None) == 429 or "rate_limit" in str(e).lower():
                fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
                if fallback_result:
                    return fallback_result
                self._handle_rate_limit(e, use_model)
            raise

    def chat_vision(self, messages: list[dict], temperature: float = 0.1, max_tokens: int = 4096) -> str:
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
                return response.choices[0].message.content
            except RateLimitError as e:
                fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
                if fallback_result:
                    return fallback_result
                self._handle_rate_limit(e, model)
            except APIStatusError as e:
                if getattr(e, "status_code", None) == 429 or "rate_limit" in str(e).lower():
                    fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
                    if fallback_result:
                        return fallback_result
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
                    fallback_result = self._try_fallback(messages, temperature, max_tokens, "groq")
                    if fallback_result:
                        return fallback_result
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


groq_service = GroqService()
