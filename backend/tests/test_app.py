from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from damusystem_backend.app import create_app
from damusystem_backend.contracts import ProfileRecord, SessionCreate, WindowBounds
from damusystem_backend.recognition import RecognitionCandidate
from damusystem_backend.runtime import EventHub, FrameItem, SessionManager


TOKEN = "test-token"
HEADERS = {"X-DaMu-Token": TOKEN}


def jpeg_bytes(text: str = "VICTORY 2026") -> bytes:
    image = np.full((160, 640, 3), 255, dtype=np.uint8)
    cv2.putText(
        image,
        text,
        (24, 105),
        cv2.FONT_HERSHEY_SIMPLEX,
        2.0,
        (0, 0, 0),
        4,
        cv2.LINE_AA,
    )
    ok, encoded = cv2.imencode(".jpg", image)
    assert ok
    return encoded.tobytes()


def make_profile(client: TestClient) -> dict:
    response = client.post(
        "/api/v1/profiles",
        headers=HEADERS,
        json={
            "name": "内置测试画面",
            "rules": [
                {
                    "match_type": "contains",
                    "pattern": "测试",
                    "template": "链路已连通 · {text}",
                    "confidence": 0.65,
                    "cooldown_ms": 5000,
                    "enabled": True,
                }
            ],
        },
    )
    assert response.status_code == 201
    return response.json()


def make_session(client: TestClient, profile_id: str) -> dict:
    response = client.post(
        "/api/v1/sessions",
        headers=HEADERS,
        json={
            "profile_id": profile_id,
            "source_id": "window:100:0",
            "hwnd": 100,
            "window_name": "DaMu Test Scene",
        },
    )
    assert response.status_code == 201
    return response.json()


def test_health_requires_token() -> None:
    with TestClient(create_app(TOKEN)) as client:
        assert client.get("/api/v1/health").status_code == 401
        response = client.get("/api/v1/health", headers=HEADERS)
        assert response.status_code == 200
        assert response.json()["recognizer"] == "dummy"
        assert response.json()["storage"] == "memory"


def test_window_bounds_are_authenticated_and_returned() -> None:
    app = create_app(
        TOKEN,
        window_bounds_reader=lambda hwnd: (
            WindowBounds(x=20, y=30, width=1280, height=720) if hwnd == 100 else None
        ),
    )
    with TestClient(app) as client:
        assert client.get("/api/v1/windows/100/bounds").status_code == 401
        response = client.get("/api/v1/windows/100/bounds", headers=HEADERS)
        assert response.status_code == 200
        assert response.json() == {"x": 20, "y": 30, "width": 1280, "height": 720}
        assert client.get("/api/v1/windows/999/bounds", headers=HEADERS).status_code == 404


def test_profile_crud_is_available_for_week_one() -> None:
    with TestClient(create_app(TOKEN)) as client:
        profile = make_profile(client)
        profile_id = profile["id"]
        patched = client.patch(
            f"/api/v1/profiles/{profile_id}",
            headers=HEADERS,
            json={"name": "更新后的测试配置"},
        )
        assert patched.status_code == 200
        assert patched.json()["name"] == "更新后的测试配置"
        assert len(client.get("/api/v1/profiles", headers=HEADERS).json()) == 1
        assert (
            client.delete(f"/api/v1/profiles/{profile_id}", headers=HEADERS).status_code
            == 204
        )


def test_expired_frame_is_rejected() -> None:
    with TestClient(create_app(TOKEN)) as client:
        profile = make_profile(client)
        session = make_session(client, profile["id"])
        response = client.post(
            f"/api/v1/sessions/{session['id']}/frames",
            headers=HEADERS,
            data={
                "frame_id": str(uuid4()),
                "region_id": profile["regions"][0]["id"],
                "captured_at": (datetime.now(UTC) - timedelta(seconds=5)).isoformat(),
                "width": "640",
                "height": "360",
            },
            files={"image": ("frame.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert response.status_code == 202
        assert response.json()["accepted"] is False
        assert response.json()["reason"] == "frame_expired"


def test_frame_emits_recognition_and_danmaku_events() -> None:
    with TestClient(create_app(TOKEN)) as client:
        profile = make_profile(client)
        with client.websocket_connect("/ws/v1/events", headers=HEADERS) as websocket:
            session = make_session(client, profile["id"])
            started = websocket.receive_json()
            assert started["type"] == "session.status"

            frame_id = uuid4()
            response = client.post(
                f"/api/v1/sessions/{session['id']}/frames",
                headers=HEADERS,
                data={
                    "frame_id": str(frame_id),
                    "region_id": profile["regions"][0]["id"],
                    "captured_at": datetime.now(UTC).isoformat(),
                    "width": "640",
                    "height": "360",
                },
                files={"image": ("frame.jpg", jpeg_bytes(), "image/jpeg")},
            )
            assert response.status_code == 202
            assert response.json()["accepted"] is True

            recognition = websocket.receive_json()
            danmaku = websocket.receive_json()
            assert recognition["type"] == "recognition.detected"
            assert recognition["payload"]["rule_evaluation"]["status"] == "emitted"
            assert recognition["payload"]["rule_evaluation"]["emitted_message_count"] == 1
            assert danmaku["type"] == "danmaku.created"
            assert UUID(danmaku["payload"]["message_id"])
            assert "链路已连通" in danmaku["payload"]["text"]

            stopped = client.delete(
                f"/api/v1/sessions/{session['id']}", headers=HEADERS
            )
            assert stopped.status_code == 204
            assert websocket.receive_json()["payload"]["status"] == "stopped"


def test_frame_validation_and_stopped_session() -> None:
    with TestClient(create_app(TOKEN)) as client:
        profile = make_profile(client)
        session = make_session(client, profile["id"])
        path = f"/api/v1/sessions/{session['id']}/frames"
        data = {
            "frame_id": str(uuid4()),
            "region_id": profile["regions"][0]["id"],
            "captured_at": datetime.now(UTC).isoformat(),
            "width": "640",
            "height": "160",
        }
        assert client.post(
            path,
            headers=HEADERS,
            data=data,
            files={"image": ("frame.png", b"png", "image/png")},
        ).status_code == 415
        assert client.post(
            path,
            headers=HEADERS,
            data=data,
            files={"image": ("frame.jpg", b"not-jpeg", "image/jpeg")},
        ).status_code == 422
        assert client.post(
            path,
            headers=HEADERS,
            data=data,
            files={"image": ("frame.jpg", b"\xff\xd8" + b"x" * (1024 * 1024) + b"\xff\xd9", "image/jpeg")},
        ).status_code == 413
        assert client.delete(
            f"/api/v1/sessions/{session['id']}", headers=HEADERS
        ).status_code == 204
        assert client.post(
            path,
            headers=HEADERS,
            data=data,
            files={"image": ("frame.jpg", jpeg_bytes(), "image/jpeg")},
        ).status_code == 404


def test_websocket_rejects_missing_token() -> None:
    with TestClient(create_app(TOKEN)) as client:
        with pytest.raises(WebSocketDisconnect) as captured:
            with client.websocket_connect("/ws/v1/events") as websocket:
                websocket.receive_text()
        assert captured.value.code == 4401


def test_latest_frame_queue_replaces_waiting_frame() -> None:
    class SlowRecognizer:
        name = "slow"

        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def recognize(self, image: bytes, preprocess_mode: str = "original"):
            self.started.set()
            await self.release.wait()
            return [RecognitionCandidate("测试", 1.0)]

        async def close(self) -> None:
            return None

    async def scenario() -> None:
        recognizer = SlowRecognizer()
        manager = SessionManager(EventHub(), recognizer)
        profile = ProfileRecord(name="queue-test")
        record = await manager.start(
            SessionCreate(
                profile_id=profile.id,
                source_id="window:1:0",
                hwnd=1,
                window_name="queue-test",
            ),
            profile,
        )

        def frame(frame_id):
            return FrameItem(
                frame_id=frame_id,
                region_id=profile.regions[0].id,
                captured_at=datetime.now(UTC),
                width=10,
                height=10,
                image=jpeg_bytes("1"),
            )

        first_id, second_id, third_id = uuid4(), uuid4(), uuid4()
        assert manager.enqueue(record.id, frame(first_id)) is None
        await recognizer.started.wait()
        assert manager.enqueue(record.id, frame(second_id)) is None
        assert manager.enqueue(record.id, frame(third_id)) == second_id
        recognizer.release.set()
        await asyncio.sleep(0)
        await manager.close_all()

    asyncio.run(scenario())


def test_session_without_rules_emits_explained_recognition_only() -> None:
    class VictoryRecognizer:
        name = "victory"

        async def recognize(self, image: bytes, preprocess_mode: str = "original"):
            return [RecognitionCandidate("胜利", 0.99996)]

        async def close(self) -> None:
            return None

    async def scenario() -> None:
        events = []

        async def collect(event) -> None:
            events.append(event)

        manager = SessionManager(EventHub(collect), VictoryRecognizer())
        profile = ProfileRecord(name="observe-only", rules=[])
        record = await manager.start(
            SessionCreate(
                profile_id=profile.id,
                source_id="window:1:0",
                hwnd=1,
                window_name="observe-only",
            ),
            profile,
        )
        manager.enqueue(
            record.id,
            FrameItem(
                frame_id=uuid4(),
                region_id=profile.regions[0].id,
                captured_at=datetime.now(UTC),
                width=10,
                height=10,
                image=jpeg_bytes("胜利"),
            ),
        )
        for _ in range(50):
            if any(event.type == "recognition.detected" for event in events):
                break
            await asyncio.sleep(0.01)

        recognition = next(event for event in events if event.type == "recognition.detected")
        assert recognition.payload["text"] == "胜利"
        assert recognition.payload["rule_evaluation"]["status"] == "no_rule"
        assert not any(event.type == "danmaku.created" for event in events)
        await manager.close_all()

    asyncio.run(scenario())


def test_global_rules_generate_for_two_profiles_without_local_rules() -> None:
    class VictoryRecognizer:
        name = "victory"

        async def recognize(self, image: bytes, preprocess_mode: str = "original"):
            return [RecognitionCandidate("胜利", 0.99996)]

        async def close(self) -> None:
            return None

    with TestClient(create_app(TOKEN, recognizer=VictoryRecognizer())) as client:
        saved = client.put(
            "/api/v1/rules/global",
            headers=HEADERS,
            json=[{
                "match_type": "contains", "pattern": "胜利", "template": "全局 · {text}",
                "confidence": 0.65, "cooldown_ms": 5000, "enabled": True,
            }],
        )
        assert saved.status_code == 200
        profiles = [
            client.post("/api/v1/profiles", headers=HEADERS, json={"name": name}).json()
            for name in ("窗口 A", "窗口 B")
        ]
        with client.websocket_connect("/ws/v1/events", headers=HEADERS) as websocket:
            for index, profile in enumerate(profiles, start=1):
                session = client.post(
                    "/api/v1/sessions",
                    headers=HEADERS,
                    json={
                        "profile_id": profile["id"], "source_id": f"window:{index}:0",
                        "hwnd": index, "window_name": profile["name"], "rule_scope": "global",
                    },
                ).json()
                assert websocket.receive_json()["payload"]["status"] == "running"
                response = client.post(
                    f"/api/v1/sessions/{session['id']}/frames",
                    headers=HEADERS,
                    data={
                        "frame_id": str(uuid4()), "region_id": profile["regions"][0]["id"],
                        "captured_at": datetime.now(UTC).isoformat(), "width": "640", "height": "160",
                    },
                    files={"image": ("frame.jpg", jpeg_bytes(), "image/jpeg")},
                )
                assert response.status_code == 202
                recognition = websocket.receive_json()
                danmaku = websocket.receive_json()
                assert recognition["payload"]["rule_evaluation"]["status"] == "emitted"
                assert danmaku["payload"]["text"] == "全局 · 胜利"
                assert client.delete(f"/api/v1/sessions/{session['id']}", headers=HEADERS).status_code == 204
                assert websocket.receive_json()["payload"]["status"] == "stopped"
