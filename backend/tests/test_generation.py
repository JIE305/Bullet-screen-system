from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from damusystem_backend.app import create_app
from damusystem_backend.contracts import (
    DanmakuRule,
    GenerationConfig,
    ProfileRecord,
    SessionCreate,
)
from damusystem_backend.generation import (
    DanmakuGenerationInput,
    GenerationBudget,
    GenerationFailure,
    GenerationService,
    clean_generated_text,
)
from damusystem_backend.recognition import RecognitionCandidate
from damusystem_backend.runtime import EventHub, FrameItem, SessionManager


TOKEN = "test-token"
HEADERS = {"X-DaMu-Token": TOKEN}


def generation_input(ocr_text: str = "胜利") -> DanmakuGenerationInput:
    return DanmakuGenerationInput(game_name="英雄联盟", ocr_text=ocr_text)


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


def test_cloud_success_uses_ocr_only_protocol_and_cleans_output() -> None:
    calls, transport = response_handler(headers={"x-request-id": "req-123"})

    async def scenario() -> None:
        generator = GenerationService(config(), transport=transport).create_generator()
        output = await generator.generate(generation_input("胜利" + "长" * 400))
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
        assert payload["max_tokens"] == 64
        user_message = payload["messages"][1]["content"]
        assert "英雄联盟" in user_message
        assert "胜利" in user_message
        assert "关键词" not in user_message
        assert "模板" not in user_message
        assert "window" not in user_message.casefold()
        assert len(user_message.split("OCR", 1)[1]) < 340

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
def test_cloud_failures_raise_without_template_fallback(
    status: int, content: object, reason: str
) -> None:
    _, transport = response_handler(status, content)

    async def scenario() -> None:
        generator = GenerationService(config(), transport=transport).create_generator()
        with pytest.raises(GenerationFailure) as caught:
            await generator.generate(generation_input())
        await generator.close()
        assert caught.value.reason == reason

    asyncio.run(scenario())


def test_network_error_and_timeout_raise_without_fallback() -> None:
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
            with pytest.raises(GenerationFailure) as caught:
                await generator.generate(generation_input())
            await generator.close()
            assert caught.value.reason == reason

        asyncio.run(scenario())


def test_generation_budget_enforces_repeat_interval_and_rolling_limit() -> None:
    now = [100.0]
    budget = GenerationBudget(
        config(min_interval_ms=5000, repeat_cooldown_ms=30000, max_calls_per_minute=2),
        clock=lambda: now[0],
    )

    async def scenario() -> None:
        assert await budget.acquire(generation_input("胜利")) is None
        assert await budget.acquire(generation_input("胜利")) == "repeat_limited"
        assert await budget.acquire(generation_input("失败")) == "interval_limited"
        now[0] += 5
        assert await budget.acquire(generation_input("失败")) is None
        now[0] += 5
        assert await budget.acquire(generation_input("击杀")) == "rate_limited"
        now[0] += 51
        assert await budget.acquire(generation_input("击杀")) is None

    asyncio.run(scenario())


def test_disabled_service_never_calls_cloud_or_falls_back() -> None:
    calls, transport = response_handler()

    async def scenario() -> None:
        disabled = config().model_copy(update={"enabled": False})
        generator = GenerationService(disabled, transport=transport).create_generator()
        assert generator.configured is False
        with pytest.raises(GenerationFailure) as caught:
            await generator.generate(generation_input())
        await generator.close()
        assert caught.value.reason == "cloud_unavailable"
        assert calls == []

    asyncio.run(scenario())


def test_generation_config_does_not_return_key_and_test_endpoint_is_removed() -> None:
    service = GenerationService()
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
        assert client.post("/api/v1/generation/test", headers=HEADERS, json={}).status_code == 404
        assert client.get("/api/v1/rules/global", headers=HEADERS).status_code == 404


class SequenceRecognizer:
    name = "sequence"

    def __init__(self, batches: list[list[RecognitionCandidate]]) -> None:
        self._values = iter(batches)

    async def recognize(self, image: bytes, preprocess_mode: str = "original"):
        return next(self._values)

    async def close(self) -> None:
        return None


def frame(region_id) -> FrameItem:
    return FrameItem(
        frame_id=uuid4(),
        region_id=region_id,
        captured_at=datetime.now(UTC),
        width=10,
        height=10,
        image=b"jpeg-placeholder",
    )


def test_real_session_calls_ai_without_keyword_and_updates_same_recognition() -> None:
    calls, transport = response_handler()

    async def scenario() -> None:
        events = []

        async def collect(event) -> None:
            events.append(event)

        profile = ProfileRecord(
            name="real-window",
            game_name="英雄联盟",
            rules=[DanmakuRule(pattern="绝不会命中", template="旧模板 {text}")],
        )
        recognizer = SequenceRecognizer(
            [[RecognitionCandidate("失败", 0.81), RecognitionCandidate("胜利", 0.99)]]
        )
        service = GenerationService(config(), transport=transport)
        manager = SessionManager(EventHub(collect), recognizer, generator_factory=service.create_generator)
        record = await manager.start(
            SessionCreate(
                profile_id=profile.id,
                source_id="window:1:0",
                hwnd=1,
                window_name="real-window",
                generation_mode="ai",
            ),
            profile,
        )
        manager.enqueue(record.id, frame(profile.regions[0].id))
        active = manager.get(record.id)
        assert active is not None
        await asyncio.wait_for(active.queue.join(), timeout=1)

        recognitions = [item for item in events if item.type == "recognition.detected"]
        low = [item for item in recognitions if item.payload["text"] == "失败"]
        high = [item for item in recognitions if item.payload["text"] == "胜利"]
        assert len(low) == 1
        assert low[0].payload["generation_evaluation"]["status"] == "not_selected"
        assert [item.payload["generation_evaluation"]["status"] for item in high] == [
            "calling",
            "generated",
        ]
        assert high[0].event_id == high[1].event_id
        danmaku = [item for item in events if item.type == "danmaku.created"]
        assert len(danmaku) == 1
        assert danmaku[0].payload["generator"] == "cloud"
        assert danmaku[0].payload["rule_id"] is None
        assert "matched_keyword" not in danmaku[0].payload
        assert len(calls) == 1
        request = json.loads(calls[0].content)
        assert "胜利" in request["messages"][1]["content"]
        assert "失败" not in request["messages"][1]["content"]
        await manager.close_all()

    asyncio.run(scenario())


def test_real_session_cloud_failure_keeps_recognition_and_emits_no_danmaku() -> None:
    _, transport = response_handler(429, {})

    async def scenario() -> None:
        events = []

        async def collect(event) -> None:
            events.append(event)

        profile = ProfileRecord(name="real-window")
        recognizer = SequenceRecognizer([[RecognitionCandidate("胜利", 0.99)]])
        service = GenerationService(config(), transport=transport)
        manager = SessionManager(EventHub(collect), recognizer, generator_factory=service.create_generator)
        record = await manager.start(
            SessionCreate(
                profile_id=profile.id,
                source_id="window:1:0",
                hwnd=1,
                window_name="real-window",
                generation_mode="ai",
            ),
            profile,
        )
        manager.enqueue(record.id, frame(profile.regions[0].id))
        active = manager.get(record.id)
        assert active is not None
        await asyncio.wait_for(active.queue.join(), timeout=1)
        statuses = [
            item.payload["generation_evaluation"]
            for item in events
            if item.type == "recognition.detected"
        ]
        assert statuses[-1] == {"status": "rate_limited", "mode": "ai", "reason": "rate_limited"}
        assert not any(item.type == "danmaku.created" for item in events)
        assert manager.get(record.id) is not None
        await manager.close_all()

    asyncio.run(scenario())


def test_profile_template_demo_never_calls_cloud() -> None:
    calls, transport = response_handler()

    async def scenario() -> None:
        events = []

        async def collect(event) -> None:
            events.append(event)

        profile = ProfileRecord(
            name="DaMu Test Scene",
            rules=[DanmakuRule(pattern="测试", template="识别到：{text}")],
        )
        recognizer = SequenceRecognizer([[RecognitionCandidate("测试", 0.99)]])
        service = GenerationService(config(), transport=transport)
        manager = SessionManager(EventHub(collect), recognizer, generator_factory=service.create_generator)
        record = await manager.start(
            SessionCreate(
                profile_id=profile.id,
                source_id="window:2:0",
                hwnd=2,
                window_name="DaMu Test Scene",
                generation_mode="profile_template",
            ),
            profile,
        )
        manager.enqueue(record.id, frame(profile.regions[0].id))
        active = manager.get(record.id)
        assert active is not None
        await asyncio.wait_for(active.queue.join(), timeout=1)
        assert calls == []
        danmaku = [item for item in events if item.type == "danmaku.created"]
        assert len(danmaku) == 1
        assert danmaku[0].payload["generator"] == "template"
        await manager.close_all()

    asyncio.run(scenario())
