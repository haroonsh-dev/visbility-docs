import os
import json
import re
import httpx
from groq import Groq
from ..config import settings


class GroqService:
    def __init__(self):
        api_key = settings.GROQ_API_KEY or os.getenv("GROQ_API_KEY", "")
        if api_key and api_key != "gsk_your_groq_api_key":
            self.client = Groq(api_key=api_key, timeout=httpx.Timeout(120.0))
        else:
            self.client = None
        self.model = "llama-3.3-70b-versatile"
        self.vision_models = [
            "meta-llama/llama-4-scout-17b-16e-instruct",
            "qwen/qwen3.6-27b",
            "llama-3.2-90b-vision-preview",
        ]
        self._vision_model_idx = 0
        self.available = self.client is not None
        self.vision_available = True

    def chat(self, messages: list[dict], temperature: float = 0.1, max_tokens: int = 4096, model: str = None) -> str:
        if not self.available:
            return self._fallback_response(messages)
        response = self.client.chat.completions.create(
            model=model or self.model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return response.choices[0].message.content

    def chat_vision(self, messages: list[dict], temperature: float = 0.1, max_tokens: int = 4096) -> str:
        if not self.available or not self.vision_available:
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
            except Exception as e:
                err = str(e).lower()
                errors.append(f"{model}: {e}")
                if "does not support image" in err or "cannot read" in err:
                    continue
                raise

        self.vision_available = False
        return self._fallback_response(messages)

    def _fallback_response(self, messages: list[dict]) -> str:
        last = messages[-1]["content"] if messages else ""
        if isinstance(last, list):
            texts = [c["text"] for c in last if isinstance(c, dict) and c.get("type") == "text"]
            last = " ".join(texts)
        return f"[Groq API not configured. Please set GROQ_API_KEY in .env]\n\nReceived: {str(last)[:200]}"

    def _parse_json(self, text: str, default: dict) -> dict:
        try:
            json_match = re.search(r'\{.*\}', text, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
            return default
        except (json.JSONDecodeError, Exception):
            return default


groq_service = GroqService()
