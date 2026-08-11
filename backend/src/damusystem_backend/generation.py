from __future__ import annotations

import asyncio
import re
import time
from collections import deque
from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4

import httpx

from .contracts import GenerationConfig, GenerationTestResult


@dataclass(frozen=True, slots=True)
class GenerationOutput:
    text: str
    generator: str
    generation_ms: float
    fallback_reason: str | None = None
    model: str | None = None
    provider_request_id: str | None = None


class DanmakuGenerator(Protocol):
    async def generate(self, ocr_text: str, local_text: str) -> GenerationOutput: ...

    async def close(self) -> None: ...


class GenerationFailure(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class MinuteRateLimiter:
    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._calls: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> bool:
        async with self._lock:
            now = time.monotonic()
            while self._calls and now - self._calls[0] >= 60:
                self._calls.popleft()
            if len(self._calls) >= self._limit:
                return False
            self._calls.append(now)
            return True


def clean_generated_text(value: str) -> str:
    text = " ".join(value.replace("\r", "\n").splitlines()).strip()
    text = re.sub(r"^(?:弹幕|回复|输出|正文)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    pairs = (("\"", "\""), ("'", "'"), ("“", "”"), ("‘", "’"))
    for left, right in pairs:
        if len(text) >= 2 and text.startswith(left) and text.endswith(right):
            text = text[len(left) : -len(right)].strip()
            break
    return text[:60].strip()


class TemplateDanmakuGenerator:
    async def generate(self, ocr_text: str, local_text: str) -> GenerationOutput:
        return GenerationOutput(local_text, "template", 0)

    async def close(self) -> None:
        return None


class CloudLLMGenerator:
    def __init__(
        self,
        config: GenerationConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = config.model_copy(deep=True)
        self._limiter = MinuteRateLimiter(config.max_calls_per_minute)
        self._client = httpx.AsyncClient(
            timeout=config.timeout_ms / 1000,
            transport=transport,
            follow_redirects=False,
        )

    async def generate(self, ocr_text: str, local_text: str) -> GenerationOutput:
        if not await self._limiter.acquire():
            raise GenerationFailure("rate_limited")
        started = time.perf_counter()
        client_request_id = str(uuid4())
        try:
            response = await self._client.post(
                f"{self._config.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._config.api_key}",
                    "Content-Type": "application/json",
                    "X-Client-Request-Id": client_request_id,
                },
                json={
                    "model": self._config.model,
                    "messages": [
                        {"role": "system", "content": self._config.system_prompt},
                        {
                            "role": "user",
                            "content": f"OCR 文字：{ocr_text}\n本地规则结果：{local_text}",
                        },
                    ],
                    "temperature": 0.8,
                    "max_tokens": 80,
                    "stream": False,
                },
            )
        except httpx.TimeoutException as exc:
            raise GenerationFailure("timeout") from exc
        except httpx.RequestError as exc:
            raise GenerationFailure("network_error") from exc

        if response.status_code in {401, 403}:
            raise GenerationFailure("authentication_failed")
        if response.status_code == 429:
            raise GenerationFailure("rate_limited")
        if not response.is_success:
            raise GenerationFailure(f"http_{response.status_code}")
        try:
            payload = response.json()
            raw_text = payload["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise GenerationFailure("invalid_response") from exc
        if not isinstance(raw_text, str):
            raise GenerationFailure("invalid_response")
        text = clean_generated_text(raw_text)
        if not text:
            raise GenerationFailure("empty_response")
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        request_id = response.headers.get("x-request-id") or response.headers.get("request-id")
        return GenerationOutput(
            text=text,
            generator="cloud",
            generation_ms=elapsed_ms,
            model=self._config.model,
            provider_request_id=request_id,
        )

    async def close(self) -> None:
        await self._client.aclose()


class FallbackDanmakuGenerator:
    def __init__(
        self,
        cloud: CloudLLMGenerator | None,
        template: TemplateDanmakuGenerator | None = None,
    ) -> None:
        self._cloud = cloud
        self._template = template or TemplateDanmakuGenerator()

    async def generate(self, ocr_text: str, local_text: str) -> GenerationOutput:
        if self._cloud is None:
            return await self._template.generate(ocr_text, local_text)
        try:
            return await self._cloud.generate(ocr_text, local_text)
        except GenerationFailure as exc:
            local = await self._template.generate(ocr_text, local_text)
            return GenerationOutput(
                text=local.text,
                generator="template",
                generation_ms=local.generation_ms,
                fallback_reason=exc.reason,
            )

    async def close(self) -> None:
        if self._cloud is not None:
            await self._cloud.close()


class GenerationService:
    def __init__(
        self,
        config: GenerationConfig | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = (config or GenerationConfig()).model_copy(deep=True)
        self._transport = transport

    @property
    def configured(self) -> bool:
        return bool(
            self._config.enabled
            and self._config.base_url
            and self._config.api_key
            and self._config.model
        )

    def configure(self, config: GenerationConfig) -> None:
        self._config = config.model_copy(deep=True)

    def create_generator(self) -> FallbackDanmakuGenerator:
        cloud = (
            CloudLLMGenerator(self._config, transport=self._transport)
            if self.configured
            else None
        )
        return FallbackDanmakuGenerator(cloud)

    async def test(self, ocr_text: str, local_text: str) -> GenerationTestResult:
        if not (self._config.base_url and self._config.api_key and self._config.model):
            raise GenerationFailure("configuration_incomplete")
        config = self._config.model_copy(update={"enabled": True})
        cloud = CloudLLMGenerator(config, transport=self._transport)
        try:
            output = await cloud.generate(ocr_text, local_text)
            return GenerationTestResult(
                text=output.text,
                elapsed_ms=output.generation_ms,
                model=config.model,
                provider_request_id=output.provider_request_id,
            )
        finally:
            await cloud.close()
