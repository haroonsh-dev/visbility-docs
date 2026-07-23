import os
import re
import io
import time
import base64
import logging
from typing import Optional

logger = logging.getLogger("visibility-docs")

VISION_IMAGE_PROMPT = """You are analyzing a single image extracted from a document page.

Extract the following if present:
- Every visible word, number, label, callout
- Figure title / caption
- Component names, part numbers, serial numbers
- Dimensions, units, symbols
- Warnings, notes, annotations
- Table text if present

If this is a machine diagram, engineering drawing, or technical illustration:
- Provide a concise factual description of what the image represents
- List every visible component label
- Do NOT hallucinate or guess

Output format:
## Figure Title
[figure title or caption if found, otherwise "Untitled Figure"]

## OCR
[every visible word and number]

## Components
[comma-separated list of detected component names and labels]

## Description
[concise factual description — only if diagram/engineering]

## Labels
[comma-separated list of all labels, callouts, annotations]

## Warnings
[any warning, caution, note text found]

Return ONLY clean Markdown. No explanations, no summaries, no questions."""


def _decode_b64_to_bytes(b64_str: str) -> bytes:
    return base64.b64decode(b64_str)


def _is_blank_b64(b64_str: str, threshold: float = 10.0) -> bool:
    try:
        from PIL import Image
        img_bytes = _decode_b64_to_bytes(b64_str)
        pil = Image.open(io.BytesIO(img_bytes)).convert("L")
        pixels = list(pil.getdata())
        if len(pixels) < 100:
            return True
        avg = sum(pixels) / len(pixels)
        variance = sum((p - avg) ** 2 for p in pixels) / len(pixels)
        return variance ** 0.5 < threshold
    except Exception:
        return False


class VisionProvider:
    SUPPORTED_PROVIDERS = {"openai", "groq", "ollama"}

    def __init__(self):
        from ..config import settings
        self.provider = (os.getenv("VISION_PROVIDER") or "groq").lower()
        self.api_key = os.getenv("VISION_API_KEY") or settings.GROQ_API_KEY or os.getenv("GROQ_API_KEY", "")
        self.model = os.getenv("VISION_MODEL") or ""
        self.api_base = os.getenv("VISION_API_BASE") or ""

        self._check_api_key()
        self._set_defaults()

    def _check_api_key(self):
        placeholders = {"your-api-key-here", "gsk_your_groq_key_here", "gsk_your_groq_api_key"}
        if not self.api_key or self.api_key in placeholders or self.api_key.startswith("gsk_your_"):
            logger.warning(f"VisionProvider: invalid API key for provider '{self.provider}'")
            self.api_key = ""

    def _set_defaults(self):
        if self.provider == "groq":
            if not self.model:
                self.model = "meta-llama/llama-4-scout-17b-16e-instruct"
            if not self.api_base:
                self.api_base = "https://api.groq.com/openai/v1"
        elif self.provider == "openai":
            if not self.model:
                self.model = "gpt-4o"
            if not self.api_base:
                self.api_base = "https://api.openai.com/v1"
        elif self.provider == "ollama":
            if not self.model:
                self.model = "llama3.2-vision"
            if not self.api_base:
                self.api_base = "http://localhost:11434"

    def analyze(self, b64_image: str) -> dict:
        if not b64_image:
            return {"markdown": "", "error": "no image data"}
        if _is_blank_b64(b64_image):
            return {"markdown": "", "error": "blank image"}

        if self.provider == "groq":
            markdown = self._call_groq(b64_image)
        elif self.provider == "openai":
            markdown = self._call_openai(b64_image)
        elif self.provider == "ollama":
            markdown = self._call_ollama(b64_image)
        else:
            return {"markdown": "", "error": f"unsupported provider '{self.provider}', use one of: {', '.join(self.SUPPORTED_PROVIDERS)}"}

        if not markdown or markdown.startswith("[Groq"):
            return {"markdown": "", "error": "API call failed"}

        parsed = self._parse_markdown(markdown)
        parsed["markdown"] = markdown
        return parsed

    def _call_groq(self, b64_image: str) -> str:
        from .groq_service import groq_service
        if not groq_service.available or not groq_service.vision_available:
            logger.warning("Groq vision not available")
            return ""
        content = [
            {"type": "text", "text": VISION_IMAGE_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"}},
        ]
        max_retries = 3
        for attempt in range(max_retries):
            try:
                result = groq_service.chat_vision(
                    [{"role": "user", "content": content}],
                    temperature=0.0,
                    max_tokens=2048,
                )
                if result and not result.startswith("[Groq"):
                    return result
                return ""
            except Exception as e:
                err_str = str(e)
                if "429" in err_str or "rate_limit" in err_str.lower():
                    import re
                    match = re.search(r"try again in (\d+\.?\d*)s", err_str)
                    wait = float(match.group(1)) + 0.5 if match else float(2 ** attempt)
                    logger.warning(f"Groq rate limited, retry {attempt+1}/{max_retries} in {wait:.1f}s")
                    time.sleep(wait)
                    continue
                logger.error(f"Groq vision call failed: {e}")
                return ""
        logger.warning(f"Groq vision failed after {max_retries} retries (rate limited)")
        return ""

    def _call_openai(self, b64_image: str) -> str:
        if not self.api_key:
            logger.warning("OpenAI API key not configured")
            return ""
        import httpx
        content = [
            {"type": "text", "text": VISION_IMAGE_PROMPT},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{b64_image}",
                    "detail": "high",
                },
            },
        ]
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": 2048,
            "temperature": 0.0,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        chat_url = f"{self.api_base.rstrip('/')}/chat/completions"
        try:
            resp = httpx.post(chat_url, json=payload, headers=headers, timeout=120)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        except Exception as e:
            err_str = str(e)
            if "429" in err_str or "rate_limit" in err_str.lower():
                logger.warning(f"OpenAI rate limited: {err_str}")
            else:
                logger.error(f"OpenAI vision call failed: {e}")
            return ""

    def _call_ollama(self, b64_image: str) -> str:
        import httpx
        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": VISION_IMAGE_PROMPT,
                    "images": [b64_image],
                }
            ],
            "options": {"temperature": 0.0},
        }
        try:
            resp = httpx.post(
                f"{self.api_base.rstrip('/')}/api/chat",
                json=payload,
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json().get("message", {}).get("content", "")
        except Exception as e:
            logger.error(f"Ollama vision call failed: {e}")
            return ""

    def _parse_markdown(self, md: str) -> dict:
        result = {
            "title": "",
            "ocr_text": "",
            "components": [],
            "labels": [],
            "warnings": [],
            "description": "",
        }
        sections = re.split(r'^##\s+', md, flags=re.MULTILINE)
        for section in sections:
            if not section.strip():
                continue
            lines = section.strip().split("\n")
            heading = lines[0].strip().lower()
            content = "\n".join(lines[1:]).strip()
            if heading.startswith("figure title"):
                result["title"] = content
            elif heading.startswith("ocr"):
                result["ocr_text"] = content
            elif heading.startswith("component"):
                result["components"] = [c.strip() for c in content.split(",") if c.strip()]
            elif heading.startswith("label"):
                result["labels"] = [c.strip() for c in content.split(",") if c.strip()]
            elif heading.startswith("warning"):
                result["warnings"] = [c.strip() for c in content.split("\n") if c.strip()]
            elif heading.startswith("description"):
                result["description"] = content
        return result


vision_provider = VisionProvider()
