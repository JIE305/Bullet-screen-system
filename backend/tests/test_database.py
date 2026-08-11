from __future__ import annotations

import asyncio
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import cv2
import numpy as np
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from damusystem_backend.app import create_app
from damusystem_backend.contracts import EventEnvelope
from damusystem_backend.database import EventWriter
from damusystem_backend.migrations import migration_root, upgrade_database


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


def upgrade_to(database: Path, revision: str) -> None:
    config = Config()
    config.set_main_option("script_location", str(migration_root()))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database.as_posix()}")
    command.upgrade(config, revision)


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
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0005_remove_legacy_victory_rule"
        assert connection.execute(
            "SELECT COUNT(*) FROM danmaku_rules WHERE profile_id IS NULL AND pattern='胜利'"
        ).fetchone()[0] == 1
        patterns = {row[0] for row in connection.execute(
            "SELECT pattern FROM danmaku_rules WHERE profile_id IS NULL"
        )}
        assert patterns == {"胜利", "失败"}
        assert connection.execute(
            "SELECT COUNT(*) FROM danmaku_rules WHERE profile_id IS NULL"
        ).fetchone()[0] == 2
        assert "game_name" in {
            row[1] for row in connection.execute("PRAGMA table_info(game_profiles)")
        }
        assert connection.execute(
            "SELECT profile_id FROM danmaku_rules WHERE id='demo-rule'"
        ).fetchone()[0] == "demo"
        assert connection.execute("SELECT rule_id FROM danmaku_messages WHERE id='m1'").fetchone()[0] == "r1"
        assert connection.execute(
            "SELECT template FROM danmaku_rules WHERE id='r1'"
        ).fetchone()[0] == "{text}"


def test_fresh_database_keeps_historical_global_rule_table_empty(tmp_path: Path) -> None:
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        assert client.get("/api/v1/rules/global", headers=HEADERS).status_code == 404

    database = tmp_path / "damusystem.sqlite3"
    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM danmaku_rules WHERE profile_id IS NULL"
        ).fetchone()[0] == 0


def test_migration_removes_only_legacy_victory_rule_and_preserves_history(
    tmp_path: Path,
) -> None:
    database = tmp_path / "legacy-victory.sqlite3"
    upgrade_to(database, "0004_empty_initial_global_rules")
    rules = [
        ("legacy", "contains", "胜利", "{text}，太强了", 0.65, 5000),
        ("custom-template", "contains", "胜利", "自定义：{text}", 0.65, 5000),
        ("custom-confidence", "contains", "胜利", "{text}，太强了", 0.70, 5000),
        ("custom-cooldown", "contains", "胜利", "{text}，太强了", 0.65, 3000),
        ("custom-exact", "exact", "胜利", "{text}，太强了", 0.65, 5000),
    ]
    with sqlite3.connect(database) as connection:
        connection.executemany(
            """
            INSERT INTO danmaku_rules
                (id, profile_id, match_type, pattern, template, confidence,
                 cooldown_ms, priority, enabled)
            VALUES (?, NULL, ?, ?, ?, ?, ?, 0, 1)
            """,
            rules,
        )
        connection.executemany(
            """
            INSERT INTO danmaku_messages
                (id, session_id, event_id, rule_id, text, style_json,
                 emitted_at, expires_at)
            VALUES (?, 'session', 'event', ?, '历史弹幕', '{}', 'now', 'later')
            """,
            [("legacy-message", "legacy"), ("custom-message", "custom-template")],
        )

    upgrade_database(database)

    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone()[0] == "0005_remove_legacy_victory_rule"
        assert connection.execute(
            "SELECT COUNT(*) FROM danmaku_rules WHERE id = 'legacy'"
        ).fetchone()[0] == 0
        assert {
            row[0]
            for row in connection.execute(
                "SELECT id FROM danmaku_rules WHERE profile_id IS NULL"
            )
        } == {
            "custom-template", "custom-confidence", "custom-cooldown", "custom-exact"
        }
        assert connection.execute(
            "SELECT rule_id FROM danmaku_messages WHERE id = 'legacy-message'"
        ).fetchone()[0] is None
        assert connection.execute(
            "SELECT rule_id FROM danmaku_messages WHERE id = 'custom-message'"
        ).fetchone()[0] == "custom-template"


def test_migration_creates_six_tables_and_profiles_survive_restart(tmp_path: Path) -> None:
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        health = client.get("/api/v1/health", headers=HEADERS).json()
        assert health["storage"] == "sqlite"
        created = client.post(
            "/api/v1/profiles",
            headers=HEADERS,
            json={
                "name": "持久化配置",
                "game_name": "英雄联盟",
                "window_title_pattern": "Game",
            },
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
        assert profiles[0]["game_name"] == "英雄联盟"


def test_events_are_written_serially_without_raw_frames(tmp_path: Path) -> None:
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        profile = client.post(
            "/api/v1/profiles",
            headers=HEADERS,
            json={"name": "事件写入", "rules": [{"pattern": "测试", "template": "{text}"}]},
        ).json()
        with client.websocket_connect("/ws/v1/events", headers=HEADERS) as websocket:
            session = client.post(
                "/api/v1/sessions",
                headers=HEADERS,
                json={
                    "profile_id": profile["id"],
                    "source_id": "window:100:0",
                    "hwnd": 100,
                    "window_name": "Fixture",
                    "generation_mode": "profile_template",
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


def test_recognition_status_updates_merge_into_one_database_row(tmp_path: Path) -> None:
    event_id = uuid4()
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        profile = client.post(
            "/api/v1/profiles", headers=HEADERS, json={"name": "状态合并"}
        ).json()
        session = client.post(
            "/api/v1/sessions",
            headers=HEADERS,
            json={
                "profile_id": profile["id"],
                "source_id": "window:merge:0",
                "window_name": "状态合并",
                "generation_mode": "ai",
            },
        ).json()
        repository = client.app.state.repository
        base_payload = {
            "region_id": profile["regions"][0]["id"],
            "text": "胜利",
            "normalized_text": "胜利",
            "confidence": 0.99,
            "content_hash": "hash",
            "observed_at": datetime.now(UTC).isoformat(),
        }
        repository.persist_event(
            EventEnvelope(
                event_id=event_id,
                type="recognition.detected",
                session_id=session["id"],
                payload={**base_payload, "generation_evaluation": {"status": "calling"}},
            )
        )
        repository.persist_event(
            EventEnvelope(
                event_id=event_id,
                type="recognition.detected",
                session_id=session["id"],
                payload={**base_payload, "generation_evaluation": {"status": "generated"}},
            )
        )

    with sqlite3.connect(tmp_path / "damusystem.sqlite3") as connection:
        rows = connection.execute(
            "SELECT metadata_json FROM recognition_events WHERE id = ?", (str(event_id),)
        ).fetchall()
        assert len(rows) == 1
        assert '"status": "generated"' in rows[0][0]


def test_patch_profile_can_remove_all_rules_and_restore_one(tmp_path: Path) -> None:
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        profile = client.post(
            "/api/v1/profiles",
            headers=HEADERS,
            json={"name": "规则同步", "rules": [{"pattern": "测试"}]},
        ).json()
        profile_id = profile["id"]
        with sqlite3.connect(tmp_path / "damusystem.sqlite3") as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM danmaku_rules WHERE profile_id = ?", (profile_id,)
            ).fetchone()[0] == 1

        observe_only = client.patch(
            f"/api/v1/profiles/{profile_id}", headers=HEADERS, json={"rules": []}
        )
        assert observe_only.status_code == 200
        assert observe_only.json()["rules"] == []
        with sqlite3.connect(tmp_path / "damusystem.sqlite3") as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM danmaku_rules WHERE profile_id = ?", (profile_id,)
            ).fetchone()[0] == 0

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
        with sqlite3.connect(tmp_path / "damusystem.sqlite3") as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM danmaku_rules WHERE profile_id = ?", (profile_id,)
            ).fetchone()[0] == 1


def test_global_rule_endpoints_remain_removed_with_sqlite(tmp_path: Path) -> None:
    with TestClient(create_app(TOKEN, data_dir=tmp_path)) as client:
        assert client.get("/api/v1/rules/global", headers=HEADERS).status_code == 404
        assert client.put("/api/v1/rules/global", headers=HEADERS, json=[]).status_code == 404
