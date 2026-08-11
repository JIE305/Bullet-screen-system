from __future__ import annotations

import asyncio
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np
from fastapi.testclient import TestClient

from damusystem_backend.app import create_app
from damusystem_backend.contracts import EventEnvelope
from damusystem_backend.database import EventWriter
from damusystem_backend.migrations import upgrade_database


TOKEN = "database-test-token"
HEADERS = {"X-DaMu-Token": TOKEN}


def jpeg_bytes() -> bytes:
    image = np.full((120, 480, 3), 255, dtype=np.uint8)
    cv2.putText(image, "TEST", (30, 85), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 0), 4)
    ok, encoded = cv2.imencode(".jpg", image)
    assert ok
    return encoded.tobytes()


def table_count(database: Path, table: str) -> int:
    with sqlite3.connect(database) as connection:
        return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def test_global_rule_migration_merges_real_profiles_and_keeps_demo_rule(tmp_path: Path) -> None:
    database = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY);
            INSERT INTO alembic_version VALUES ('0001_initial');
            CREATE TABLE game_profiles (
                id VARCHAR(36) PRIMARY KEY, name VARCHAR(80) NOT NULL,
                window_title_pattern VARCHAR(200), overlay_settings TEXT,
                created_at VARCHAR(40) NOT NULL, updated_at VARCHAR(40) NOT NULL
            );
            CREATE TABLE danmaku_rules (
                id VARCHAR(36) PRIMARY KEY, profile_id VARCHAR(36) NOT NULL,
                match_type VARCHAR(20) NOT NULL, pattern VARCHAR(200) NOT NULL,
                template VARCHAR(240) NOT NULL, confidence FLOAT NOT NULL,
                cooldown_ms INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY(profile_id) REFERENCES game_profiles(id) ON DELETE CASCADE
            );
            CREATE TABLE danmaku_messages (
                id VARCHAR(36) PRIMARY KEY, session_id VARCHAR(36) NOT NULL,
                event_id VARCHAR(36) NOT NULL, rule_id VARCHAR(36), text TEXT NOT NULL,
                style_json TEXT NOT NULL, emitted_at VARCHAR(40) NOT NULL,
                expires_at VARCHAR(40) NOT NULL
            );
            INSERT INTO game_profiles VALUES ('a','窗口 A','A',NULL,'now','now');
            INSERT INTO game_profiles VALUES ('b','窗口 B','B',NULL,'now','now');
            INSERT INTO game_profiles VALUES ('demo','DaMu Test Scene','DaMu Test Scene',NULL,'now','now');
            INSERT INTO danmaku_rules VALUES ('r1','a','contains','胜利','{text}',0.65,5000,0,1);
            INSERT INTO danmaku_rules VALUES ('r2','b','contains','胜利','{text}',0.65,5000,0,1);
            INSERT INTO danmaku_rules VALUES ('r3','b','exact','失败','失败 · {text}',0.70,3000,0,1);
            INSERT INTO danmaku_rules VALUES ('demo-rule','demo','contains','测试','{text}',0.65,5000,0,1);
            INSERT INTO danmaku_messages VALUES ('m1','s1','e1','r2','胜利','{}','now','later');
            """
        )

    upgrade_database(database)

    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0002_global_rules"
        assert connection.execute(
            "SELECT COUNT(*) FROM danmaku_rules WHERE profile_id IS NULL AND pattern='胜利'"
        ).fetchone()[0] == 1
        assert {row[0] for row in connection.execute(
            "SELECT pattern FROM danmaku_rules WHERE profile_id IS NULL"
        )} == {"胜利", "失败"}
        assert connection.execute(
            "SELECT profile_id FROM danmaku_rules WHERE id='demo-rule'"
        ).fetchone()[0] == "demo"
        assert connection.execute("SELECT rule_id FROM danmaku_messages WHERE id='m1'").fetchone()[0] == "r1"


def test_migration_creates_six_tables_and_profiles_survive_restart(tmp_path: Path) -> None:
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        health = client.get("/api/v1/health", headers=HEADERS).json()
        assert health["storage"] == "sqlite"
        created = client.post(
            "/api/v1/profiles",
            headers=HEADERS,
            json={"name": "持久化配置", "window_title_pattern": "Game"},
        ).json()

    database = tmp_path / "damusystem.sqlite3"
    with sqlite3.connect(database) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    assert {
        "game_profiles",
        "recognition_regions",
        "danmaku_rules",
        "capture_sessions",
        "recognition_events",
        "danmaku_messages",
    }.issubset(tables)

    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        profiles = client.get("/api/v1/profiles", headers=HEADERS).json()
        assert [profile["id"] for profile in profiles] == [created["id"]]


def test_events_are_written_serially_without_raw_frames(tmp_path: Path) -> None:
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        profile = client.post(
            "/api/v1/profiles", headers=HEADERS, json={"name": "事件写入"}
        ).json()
        client.put(
            "/api/v1/rules/global",
            headers=HEADERS,
            json=[{
                "match_type": "contains", "pattern": "测试", "template": "{text}",
                "confidence": 0.65, "cooldown_ms": 5000, "enabled": True,
            }],
        )
        with client.websocket_connect("/ws/v1/events", headers=HEADERS) as websocket:
            session = client.post(
                "/api/v1/sessions",
                headers=HEADERS,
                json={
                    "profile_id": profile["id"],
                    "source_id": "window:100:0",
                    "hwnd": 100,
                    "window_name": "Fixture",
                    "rule_scope": "global",
                },
            ).json()
            websocket.receive_json()
            response = client.post(
                f"/api/v1/sessions/{session['id']}/frames",
                headers=HEADERS,
                data={
                    "frame_id": str(uuid4()),
                    "region_id": profile["regions"][0]["id"],
                    "captured_at": datetime.now(UTC).isoformat(),
                    "width": "480",
                    "height": "120",
                },
                files={"image": ("frame.jpg", jpeg_bytes(), "image/jpeg")},
            )
            assert response.status_code == 202
            assert websocket.receive_json()["type"] == "recognition.detected"
            assert websocket.receive_json()["type"] == "danmaku.created"

    database = tmp_path / "damusystem.sqlite3"
    assert table_count(database, "capture_sessions") == 1
    assert table_count(database, "recognition_events") == 1
    assert table_count(database, "danmaku_messages") == 1
    with sqlite3.connect(database) as connection:
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(recognition_events)")
        }
    assert "image" not in columns
    assert "frame" not in columns


def test_database_failure_is_recorded_without_breaking_event_delivery() -> None:
    class FailingRepository:
        def cleanup(self) -> None:
            return None

        def persist_event(self, _: EventEnvelope) -> None:
            raise OSError("database unavailable")

    async def scenario() -> None:
        writer = EventWriter(FailingRepository())  # type: ignore[arg-type]
        writer.start()
        await writer.enqueue(EventEnvelope(type="error", payload={"message": "test"}))
        await writer.queue.join()
        assert writer.last_error == "database unavailable"
        await writer.stop()

    asyncio.run(scenario())


def test_patch_profile_can_remove_all_rules_and_restore_one(tmp_path: Path) -> None:
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        profile = client.post(
            "/api/v1/profiles",
            headers=HEADERS,
            json={"name": "规则同步", "rules": [{"pattern": "测试"}]},
        ).json()
        profile_id = profile["id"]
        assert table_count(tmp_path / "damusystem.sqlite3", "danmaku_rules") == 1

        observe_only = client.patch(
            f"/api/v1/profiles/{profile_id}", headers=HEADERS, json={"rules": []}
        )
        assert observe_only.status_code == 200
        assert observe_only.json()["rules"] == []
        assert table_count(tmp_path / "damusystem.sqlite3", "danmaku_rules") == 0

        restored = client.patch(
            f"/api/v1/profiles/{profile_id}",
            headers=HEADERS,
            json={
                "rules": [
                    {
                        "match_type": "contains",
                        "pattern": "胜利",
                        "template": "{text}",
                        "confidence": 0.65,
                        "cooldown_ms": 5000,
                    }
                ]
            },
        )
        assert restored.status_code == 200
        assert restored.json()["rules"][0]["pattern"] == "胜利"
        assert table_count(tmp_path / "damusystem.sqlite3", "danmaku_rules") == 1


def test_global_rules_are_shared_by_different_profiles_and_survive_restart(tmp_path: Path) -> None:
    rules = [
        {
            "match_type": "contains", "pattern": "胜利", "template": "胜利 · {text}",
            "confidence": 0.65, "cooldown_ms": 5000, "enabled": True,
        },
        {
            "match_type": "exact", "pattern": "失败", "template": "失败 · {text}",
            "confidence": 0.7, "cooldown_ms": 3000, "enabled": True,
        },
    ]
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        saved = client.put("/api/v1/rules/global", headers=HEADERS, json=rules)
        assert saved.status_code == 200
        assert [item["pattern"] for item in saved.json()] == ["胜利", "失败"]
        first = client.post("/api/v1/profiles", headers=HEADERS, json={"name": "窗口 A"}).json()
        second = client.post("/api/v1/profiles", headers=HEADERS, json={"name": "窗口 B"}).json()
        assert first["rules"] == []
        assert second["rules"] == []
        for profile in (first, second):
            session = client.post(
                "/api/v1/sessions",
                headers=HEADERS,
                json={
                    "profile_id": profile["id"], "source_id": "window:1:0", "hwnd": 1,
                    "window_name": profile["name"], "rule_scope": "global",
                },
            )
            assert session.status_code == 201
            assert client.delete(f"/api/v1/sessions/{session.json()['id']}", headers=HEADERS).status_code == 204

    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        restored = client.get("/api/v1/rules/global", headers=HEADERS)
        assert [item["pattern"] for item in restored.json()] == ["胜利", "失败"]
