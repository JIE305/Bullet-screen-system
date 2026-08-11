from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from damusystem_backend.app import create_app
from damusystem_backend.contracts import DanmakuRule, GenerationConfig, ProfileRecord, SessionCreate
from damusystem_backend.generation import (
    FallbackDanmakuGenerator,
    GenerationFailure,
    GenerationService,
    clean_generated_text,
)
from damusystem_backend.recognition import RecognitionCandidate
from damusystem_backend.runtime import EventHub, FrameItem, SessionManager


TOKEN = "test-token"
HEADERS = {"X-DaMu-Token": TOKEN}


def config(**changes: object) -> GenerationConfig:
    return GenerationConfig(
        enabled=True,
        base_url="https://example.test/v1",
        api_key="secret-key-value",
        model="demo-model",
        **changes,
    )


def response_handler(
    status: int = 200,
    content: object = None,
    headers: dict[str, str] | None = None,
):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        body = content if content is not None else {
            "choices": [{"message": {"content": "“这波胜利太漂亮了！”"}}]
        }
        return httpx.Response(status, json=body, headers=headers, request=request)

    return calls, httpx.MockTransport(handler)


def test_clean_generated_text_removes_wrapper_and_limits_length() -> None:
    assert clean_generated_text("弹幕：\n“漂亮的一局！”") == "漂亮的一局！"
    assert len(clean_generated_text("好" * 100)) == 60


def test_config_only_accepts_https_or_loopback_http() -> None:
    assert GenerationConfig(base_url="http://127.0.0.1:8080/v1").base_url.endswith("/v1")
    with pytest.raises(ValueError):
        GenerationConfig(base_url="http://example.com/v1")
    with pytest.raises(ValueError):
        GenerationConfig(enabled=True, base_url="https://example.com/v1")


def test_cloud_success_uses_expected_protocol_and_cleans_output() -> None:
    calls, transport = response_handler(headers={"x-request-id": "req-123"})

    async def scenario() -> None:
        service = GenerationService(config(), transport=transport)
        generator = service.create_generator()
        output = await generator.generate("胜利", "胜利")
        await generator.close()
        assert output.text == "这波胜利太漂亮了！"
        assert output.generator == "cloud"
        assert output.model == "demo-model"
        assert output.provider_request_id == "req-123"
        assert len(calls) == 1
        assert calls[0].url == "https://example.test/v1/chat/completions"
        assert calls[0].headers["authorization"] == "Bearer secret-key-value"
        payload = json.loads(calls[0].content)
        assert payload["stream"] is False
        assert payload["temperature"] == 0.8
        assert payload["max_tokens"] == 80
        assert "胜利" in payload["messages"][1]["content"]

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("status", "content", "reason"),
    [
        (401, {}, "authentication_failed"),
        (403, {}, "authentication_failed"),
        (429, {}, "rate_limited"),
        (500, {}, "http_500"),
        (200, {}, "invalid_response"),
        (200, {"choices": [{"message": {"content": ""}}]}, "empty_response"),
    ],
)
def test_cloud_failures_fall_back_to_local_template(
    status: int, content: object, reason: str
) -> None:
    _, transport = response_handler(status, content)

    async def scenario() -> None:
        generator = GenerationService(config(), transport=transport).create_generator()
        output = await generator.generate("胜利", "本地胜利")
        await generator.close()
        assert output.text == "本地胜利"
        assert output.generator == "template"
        assert output.fallback_reason == reason

    asyncio.run(scenario())


def test_network_error_and_timeout_fall_back() -> None:
    for exception, reason in [
        (httpx.ConnectError("offline"), "network_error"),
        (httpx.ReadTimeout("slow"), "timeout"),
    ]:
        def handler(request: httpx.Request, current=exception) -> httpx.Response:
            current.request = request
            raise current

        async def scenario() -> None:
            generator = GenerationService(
                config(), transport=httpx.MockTransport(handler)
            ).create_generator()
            output = await generator.generate("胜利", "本地胜利")
            await generator.close()
            assert output.fallback_reason == reason

        asyncio.run(scenario())


def test_local_rate_limit_falls_back_without_extra_request() -> None:
    calls, transport = response_handler()

    async def scenario() -> None:
        generator = GenerationService(
            config(max_calls_per_minute=1), transport=transport
        ).create_generator()
        first = await generator.generate("胜利", "胜利")
        second = await generator.generate("失败", "失败")
        await generator.close()
        assert first.generator == "cloud"
        assert second.generator == "template"
        assert second.fallback_reason == "rate_limited"
        assert len(calls) == 1

    asyncio.run(scenario())


def test_disabled_service_never_calls_cloud() -> None:
    calls, transport = response_handler()

    async def scenario() -> None:
        disabled = config().model_copy(update={"enabled": False})
        generator = GenerationService(disabled, transport=transport).create_generator()
        output = await generator.generate("胜利", "本地胜利")
        await generator.close()
        assert output.generator == "template"
        assert output.fallback_reason is None
        assert calls == []

    asyncio.run(scenario())


def test_generation_config_and_test_endpoints_do_not_return_key() -> None:
    calls, transport = response_handler()
    service = GenerationService(transport=transport)
    with TestClient(create_app(TOKEN, generation_service=service)) as client:
        saved = client.put(
            "/api/v1/generation/config",
            headers=HEADERS,
            json=config().model_dump(),
        )
        assert saved.status_code == 200
        assert saved.json() == {
            "enabled": True,
            "configured": True,
            "model": "demo-model",
        }
        assert "secret-key-value" not in saved.text
        tested = client.post(
            "/api/v1/generation/test",
            headers=HEADERS,
            json={"text": "胜利", "local_text": "胜利"},
        )
        assert tested.status_code == 200
        assert tested.json()["text"] == "这波胜利太漂亮了！"
        assert "secret-key-value" not in tested.text
        assert len(calls) == 1


def test_generation_test_reports_safe_failure_reason() -> None:
    service = GenerationService(config(), transport=httpx.MockTransport(
        lambda request: httpx.Response(401, request=request)
    ))
    with TestClient(create_app(TOKEN, generation_service=service)) as client:
        response = client.post(
            "/api/v1/generation/test",
            headers=HEADERS,
            json={"text": "胜利", "local_text": "胜利"},
        )
        assert response.status_code == 502
        assert response.json()["detail"] == "authentication_failed"
        assert "secret-key-value" not in response.text


def test_keyword_gate_calls_cloud_once_and_dedupe_prevents_repeat() -> None:
    calls, transport = response_handler()

    class SequenceRecognizer:
        name = "sequence"

        def __init__(self) -> None:
            self.values = iter(["失败", "胜利", "胜利"])

        async def recognize(self, image: bytes, preprocess_mode: str = "original"):
            return [RecognitionCandidate(next(self.values), 0.99)]

        async def close(self) -> None:
            return None

    async def scenario() -> None:
        events = []

        async def collect(event) -> None:
            events.append(event)

        service = GenerationService(config(), transport=transport)
        profile = ProfileRecord(
            name="keyword-gate",
            rules=[DanmakuRule(pattern="胜利", template="本地：{text}")],
        )
        manager = SessionManager(
            EventHub(collect), SequenceRecognizer(), generator_factory=service.create_generator
        )
        record = await manager.start(
            SessionCreate(
                profile_id=profile.id,
                source_id="window:1:0",
                hwnd=1,
                window_name="keyword-gate",
            ),
            profile,
        )

        async def submit_and_wait() -> None:
            manager.enqueue(
                record.id,
                FrameItem(
                    frame_id=uuid4(),
                    region_id=profile.regions[0].id,
                    captured_at=datetime.now(UTC),
                    width=10,
                    height=10,
                    image=b"jpeg-placeholder",
                ),
            )
            active = manager.get(record.id)
            assert active is not None
            await asyncio.wait_for(active.queue.join(), timeout=1)

        await submit_and_wait()
        assert len(calls) == 0
        await submit_and_wait()
        assert len(calls) == 1
        await submit_and_wait()
        assert len(calls) == 1
        assert sum(event.type == "danmaku.created" for event in events) == 1
        await manager.close_all()

    asyncio.run(scenario())
