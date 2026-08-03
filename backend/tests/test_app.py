from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from damusystem_backend.app import create_app
from damusystem_backend.contracts import WindowBounds


TOKEN = "test-token"
HEADERS = {"X-DaMu-Token": TOKEN}


def make_profile(client: TestClient) -> dict:
    response = client.post(
        "/api/v1/profiles", headers=HEADERS, json={"name": "内置测试画面"}
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
            files={"image": ("frame.jpg", b"jpeg", "image/jpeg")},
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
                files={"image": ("frame.jpg", b"fake-jpeg-content", "image/jpeg")},
            )
            assert response.status_code == 202
            assert response.json()["accepted"] is True

            recognition = websocket.receive_json()
            danmaku = websocket.receive_json()
            assert recognition["type"] == "recognition.detected"
            assert danmaku["type"] == "danmaku.created"
            assert UUID(danmaku["payload"]["message_id"])
            assert "链路已连通" in danmaku["payload"]["text"]

            stopped = client.delete(
                f"/api/v1/sessions/{session['id']}", headers=HEADERS
            )
            assert stopped.status_code == 204
            assert websocket.receive_json()["payload"]["status"] == "stopped"
