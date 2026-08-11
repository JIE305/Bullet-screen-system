from __future__ import annotations

import asyncio
import re
import time
import unicodedata
from collections import deque
from dataclasses import dataclass
from typing import Callable, Protocol
from uuid import uuid4

import httpx

from .contracts import GenerationConfig


@dataclass(frozen=True, slots=True)
class GenerationOutput:
    text: str
    generator: str
    generation_ms: float
    model: str | None = None
    provider_request_id: str | None = None


@dataclass(frozen=True, slots=True)
class DanmakuGenerationInput:
    game_name: str | None
    ocr_text: str


class DanmakuGenerator(Protocol):
    async def generate(self, value: DanmakuGenerationInput) -> GenerationOutput: ...

    async def close(self) -> None: ...


class GenerationFailure(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class GenerationBudget:
    def __init__(
        self,
        config: GenerationConfig,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config.model_copy(deep=True)
        self._clock = clock
        self._calls: deque[float] = deque()
        self._last_call: float | None = None
        self._last_by_text: dict[tuple[str, str], float] = {}
        self._lock = asyncio.Lock()

    async def acquire(self, value: DanmakuGenerationInput) -> str | None:
        async with self._lock:
            now = self._clock()
            while self._calls and now - self._calls[0] >= 60:
                self._calls.popleft()
            normalize = lambda text: " ".join(
                unicodedata.normalize("NFKC", text).strip().casefold().split()
            )
            key = (normalize(value.game_name or ""), normalize(value.ocr_text))
            repeated_at = self._last_by_text.get(key)
            if repeated_at is not None and now - repeated_at < self._config.repeat_cooldown_ms / 1000:
                return "repeat_limited"
            if self._last_call is not None and now - self._last_call < self._config.min_interval_ms / 1000:
                return "interval_limited"
            if len(self._calls) >= self._config.max_calls_per_minute:
                return "rate_limited"
            self._calls.append(now)
            self._last_call = now
            self._last_by_text[key] = now
            return None


def clean_generated_text(value: str) -> str:
    text = " ".join(value.replace("\r", "\n").splitlines()).strip()
    text = re.sub(r"^(?:弹幕|回复|输出|正文)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    pairs = (("\"", "\""), ("'", "'"), ("“", "”"), ("‘", "’"))
    for left, right in pairs:
        if len(text) >= 2 and text.startswith(left) and text.endswith(right):
            text = text[len(left) : -len(right)].strip()
            break
    return text[:60].strip()


class CloudLLMGenerator:
    def __init__(
        self,
        config: GenerationConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = config.model_copy(deep=True)
        self._client = httpx.AsyncClient(
            timeout=config.timeout_ms / 1000,
            transport=transport,
            follow_redirects=False,
        )

    async def generate(self, value: DanmakuGenerationInput) -> GenerationOutput:
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
                            "content": (
                                f"游戏名称候选：{value.game_name or '未知'}\n"
                                f"OCR 文字：{value.ocr_text[:300]}"
                            ),
                        },
                    ],
                    "temperature": 0.8,
                    "max_tokens": 64,
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


class DirectAiDanmakuGenerator:
    def __init__(
        self,
        config: GenerationConfig,
        cloud: CloudLLMGenerator | None,
        budget: GenerationBudget,
    ) -> None:
        self._config = config.model_copy(deep=True)
        self._cloud = cloud
        self._budget = budget

    @property
    def minimum_confidence(self) -> float:
        return self._config.min_confidence

    @property
    def configured(self) -> bool:
        return self._cloud is not None

    async def generate(self, value: DanmakuGenerationInput) -> GenerationOutput:
        if self._cloud is None:
            raise GenerationFailure("cloud_unavailable")
        limited = await self.reserve(value)
        if limited:
            raise GenerationFailure(limited)
        return await self.generate_reserved(value)

    async def reserve(self, value: DanmakuGenerationInput) -> str | None:
        return await self._budget.acquire(value)

    async def generate_reserved(self, value: DanmakuGenerationInput) -> GenerationOutput:
        if self._cloud is None:
            raise GenerationFailure("cloud_unavailable")
        return await self._cloud.generate(value)

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
        self._budget = GenerationBudget(self._config)

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
        self._budget = GenerationBudget(self._config)

    def create_generator(self) -> DirectAiDanmakuGenerator:
        cloud = (
            CloudLLMGenerator(self._config, transport=self._transport)
            if self.configured
            else None
        )
        return DirectAiDanmakuGenerator(self._config, cloud, self._budget)
