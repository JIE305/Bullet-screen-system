from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import Float, ForeignKey, Index, Integer, String, Text, create_engine, delete, event, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from .contracts import (
    DanmakuRule,
    EventEnvelope,
    ProfileCreate,
    ProfilePatch,
    ProfileRecord,
    RecognitionRegion,
    SessionRecord,
    utc_now,
)
from .migrations import upgrade_database

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class GameProfile(Base):
    __tablename__ = "game_profiles"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), index=True)
    window_title_pattern: Mapped[str | None] = mapped_column(String(200))
    overlay_settings: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(40))
    updated_at: Mapped[str] = mapped_column(String(40))
    regions: Mapped[list[RecognitionRegionModel]] = relationship(cascade="all, delete-orphan")
    rules: Mapped[list[DanmakuRuleModel]] = relationship(cascade="all, delete-orphan")


class RecognitionRegionModel(Base):
    __tablename__ = "recognition_regions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("game_profiles.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    width: Mapped[float] = mapped_column(Float)
    height: Mapped[float] = mapped_column(Float)
    recognition_type: Mapped[str] = mapped_column(String(30), default="ocr")
    preprocess_mode: Mapped[str] = mapped_column(String(30), default="original")
    config: Mapped[str] = mapped_column(Text, default="{}")
    enabled: Mapped[int] = mapped_column(Integer, default=1)


class DanmakuRuleModel(Base):
    __tablename__ = "danmaku_rules"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("game_profiles.id", ondelete="CASCADE"), index=True, nullable=True
    )
    match_type: Mapped[str] = mapped_column(String(20))
    pattern: Mapped[str] = mapped_column(String(200))
    template: Mapped[str] = mapped_column(String(240))
    confidence: Mapped[float] = mapped_column(Float)
    cooldown_ms: Mapped[int] = mapped_column(Integer)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[int] = mapped_column(Integer, default=1)


class CaptureSessionModel(Base):
    __tablename__ = "capture_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("game_profiles.id", ondelete="CASCADE"), index=True)
    source_id: Mapped[str] = mapped_column(String(240))
    hwnd: Mapped[int | None] = mapped_column(Integer)
    window_name: Mapped[str] = mapped_column(String(240))
    started_at: Mapped[str] = mapped_column(String(40), index=True)
    ended_at: Mapped[str | None] = mapped_column(String(40))
    end_reason: Mapped[str | None] = mapped_column(String(80))


class RecognitionEventModel(Base):
    __tablename__ = "recognition_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("capture_sessions.id", ondelete="CASCADE"), index=True)
    region_id: Mapped[str] = mapped_column(ForeignKey("recognition_regions.id", ondelete="CASCADE"), index=True)
    normalized_text: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float] = mapped_column(Float)
    content_hash: Mapped[str] = mapped_column(String(64))
    occurred_at: Mapped[str] = mapped_column(String(40), index=True)
    metadata_json: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("ix_recognition_hash_time", "content_hash", "occurred_at"),)


class DanmakuMessageModel(Base):
    __tablename__ = "danmaku_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("capture_sessions.id", ondelete="CASCADE"), index=True)
    event_id: Mapped[str] = mapped_column(ForeignKey("recognition_events.id", ondelete="CASCADE"), index=True)
    rule_id: Mapped[str | None] = mapped_column(ForeignKey("danmaku_rules.id", ondelete="SET NULL"), index=True)
    text: Mapped[str] = mapped_column(Text)
    style_json: Mapped[str] = mapped_column(Text)
    emitted_at: Mapped[str] = mapped_column(String(40), index=True)
    expires_at: Mapped[str] = mapped_column(String(40))


class Repository:
    def __init__(self, database_path: Path) -> None:
        database_path.parent.mkdir(parents=True, exist_ok=True)
        upgrade_database(database_path)
        self.engine = create_engine(
            f"sqlite:///{database_path.as_posix()}",
            connect_args={"check_same_thread": False, "timeout": 5},
        )

        @event.listens_for(self.engine, "connect")
        def configure_sqlite(dbapi_connection: Any, _: Any) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()

        self.sessions = sessionmaker(self.engine, expire_on_commit=False)

    def close(self) -> None:
        self.engine.dispose()

    def list_profiles(self) -> list[ProfileRecord]:
        with self.sessions() as session:
            return [self._profile_record(item) for item in session.scalars(select(GameProfile)).all()]

    def get_profile(self, profile_id: UUID) -> ProfileRecord | None:
        with self.sessions() as session:
            item = session.get(GameProfile, str(profile_id))
            return self._profile_record(item) if item else None

    def list_global_rules(self) -> list[DanmakuRule]:
        with self.sessions() as session:
            statement = (
                select(DanmakuRuleModel)
                .where(DanmakuRuleModel.profile_id.is_(None))
                .order_by(DanmakuRuleModel.priority, DanmakuRuleModel.pattern, DanmakuRuleModel.id)
            )
            return [self._rule_record(item) for item in session.scalars(statement).all()]

    def replace_global_rules(self, rules: list[DanmakuRule]) -> list[DanmakuRule]:
        with self.sessions.begin() as session:
            existing = {
                item.id: item
                for item in session.scalars(
                    select(DanmakuRuleModel).where(DanmakuRuleModel.profile_id.is_(None))
                ).all()
            }
            retained: set[str] = set()
            for priority, rule in enumerate(rules):
                rule_id = str(rule.id)
                item = existing.get(rule_id)
                if item is None:
                    item = DanmakuRuleModel(id=rule_id, profile_id=None)
                    session.add(item)
                item.match_type = rule.match_type
                item.pattern = rule.pattern
                item.template = rule.template
                item.confidence = rule.confidence
                item.cooldown_ms = rule.cooldown_ms
                item.priority = priority
                item.enabled = int(rule.enabled)
                retained.add(rule_id)
            for rule_id, item in existing.items():
                if rule_id not in retained:
                    session.delete(item)
        return self.list_global_rules()

    def create_profile(self, payload: ProfileCreate) -> ProfileRecord:
        record = ProfileRecord(**payload.model_dump())
        with self.sessions.begin() as session:
            session.add(self._profile_model(record))
        return record

    def patch_profile(self, profile_id: UUID, payload: ProfilePatch) -> ProfileRecord | None:
        existing = self.get_profile(profile_id)
        if existing is None:
            return None
        changes = payload.model_dump(exclude_unset=True)
        if payload.regions is not None:
            changes["regions"] = [
                region.model_copy(
                    update={"id": existing.regions[index].id}
                    if index < len(existing.regions)
                    else {}
                )
                for index, region in enumerate(payload.regions)
            ]
        if payload.rules is not None:
            changes["rules"] = [
                rule.model_copy(
                    update={"id": existing.rules[index].id}
                    if index < len(existing.rules)
                    else {}
                )
                for index, rule in enumerate(payload.rules)
            ]
        updated = existing.model_copy(update={**changes, "updated_at": utc_now()})
        with self.sessions.begin() as session:
            item = session.get(GameProfile, str(profile_id))
            if item is None:
                return None
            item.name = updated.name
            item.window_title_pattern = updated.window_title_pattern
            item.updated_at = updated.updated_at.isoformat()
            for index, region in enumerate(updated.regions):
                if index < len(item.regions):
                    target = item.regions[index]
                    target.name = region.name
                    target.x, target.y = region.x, region.y
                    target.width, target.height = region.width, region.height
                    target.preprocess_mode = region.preprocess_mode
                    target.enabled = int(region.enabled)
                else:
                    item.regions.append(
                        RecognitionRegionModel(
                            id=str(region.id), profile_id=item.id, name=region.name,
                            x=region.x, y=region.y, width=region.width, height=region.height,
                            preprocess_mode=region.preprocess_mode, enabled=int(region.enabled),
                        )
                    )
            for index, rule in enumerate(updated.rules):
                if index < len(item.rules):
                    target_rule = item.rules[index]
                    target_rule.match_type = rule.match_type
                    target_rule.pattern = rule.pattern
                    target_rule.template = rule.template
                    target_rule.confidence = rule.confidence
                    target_rule.cooldown_ms = rule.cooldown_ms
                    target_rule.enabled = int(rule.enabled)
                else:
                    item.rules.append(
                        DanmakuRuleModel(
                            id=str(rule.id), profile_id=item.id, match_type=rule.match_type,
                            pattern=rule.pattern, template=rule.template,
                            confidence=rule.confidence, cooldown_ms=rule.cooldown_ms,
                            enabled=int(rule.enabled),
                        )
                    )
            if len(item.rules) > len(updated.rules):
                del item.rules[len(updated.rules):]
        return updated

    def delete_profile(self, profile_id: UUID) -> bool:
        with self.sessions.begin() as session:
            item = session.get(GameProfile, str(profile_id))
            if item is None:
                return False
            session.delete(item)
        return True

    def save_session(self, record: SessionRecord) -> None:
        with self.sessions.begin() as session:
            session.merge(
                CaptureSessionModel(
                    id=str(record.id),
                    profile_id=str(record.profile_id),
                    source_id=record.source_id,
                    hwnd=record.hwnd,
                    window_name=record.window_name,
                    started_at=record.started_at.isoformat(),
                    ended_at=record.ended_at.isoformat() if record.ended_at else None,
                    end_reason=record.end_reason,
                )
            )

    def persist_event(self, envelope: EventEnvelope) -> None:
        if envelope.session_id is None:
            return
        payload = envelope.payload
        with self.sessions.begin() as session:
            if envelope.type == "recognition.detected":
                session.merge(
                    RecognitionEventModel(
                        id=str(envelope.event_id),
                        session_id=str(envelope.session_id),
                        region_id=str(payload["region_id"]),
                        normalized_text=str(payload.get("normalized_text", "")),
                        confidence=float(payload.get("confidence", 0)),
                        content_hash=str(payload.get("content_hash", "")),
                        occurred_at=str(payload.get("observed_at", envelope.emitted_at.isoformat())),
                        metadata_json=json.dumps(payload, ensure_ascii=False),
                    )
                )
            elif envelope.type == "danmaku.created":
                emitted = envelope.emitted_at.astimezone(UTC)
                duration = int(payload.get("duration_ms", 7200))
                session.merge(
                    DanmakuMessageModel(
                        id=str(payload["message_id"]),
                        session_id=str(envelope.session_id),
                        event_id=str(payload["recognition_event_id"]),
                        rule_id=str(payload["rule_id"]) if payload.get("rule_id") else None,
                        text=str(payload.get("text", "")),
                        style_json=json.dumps(payload.get("style", {}), ensure_ascii=False),
                        emitted_at=emitted.isoformat(),
                        expires_at=(emitted + timedelta(milliseconds=duration)).isoformat(),
                    )
                )

    def cleanup(self, retention_days: int = 7) -> None:
        cutoff = (datetime.now(UTC) - timedelta(days=retention_days)).isoformat()
        with self.sessions.begin() as session:
            session.execute(delete(DanmakuMessageModel).where(DanmakuMessageModel.emitted_at < cutoff))
            session.execute(delete(RecognitionEventModel).where(RecognitionEventModel.occurred_at < cutoff))
            session.execute(delete(CaptureSessionModel).where(CaptureSessionModel.started_at < cutoff))

    @staticmethod
    def _profile_model(record: ProfileRecord) -> GameProfile:
        return GameProfile(
            id=str(record.id),
            name=record.name,
            window_title_pattern=record.window_title_pattern,
            overlay_settings=None,
            created_at=record.created_at.isoformat(),
            updated_at=record.updated_at.isoformat(),
            regions=[
                RecognitionRegionModel(
                    id=str(region.id), profile_id=str(record.id), name=region.name,
                    x=region.x, y=region.y, width=region.width, height=region.height,
                    preprocess_mode=region.preprocess_mode, enabled=int(region.enabled),
                ) for region in record.regions
            ],
            rules=[
                DanmakuRuleModel(
                    id=str(rule.id), profile_id=str(record.id), match_type=rule.match_type,
                    pattern=rule.pattern, template=rule.template, confidence=rule.confidence,
                    cooldown_ms=rule.cooldown_ms, enabled=int(rule.enabled),
                ) for rule in record.rules
            ],
        )

    @staticmethod
    def _profile_record(item: GameProfile) -> ProfileRecord:
        return ProfileRecord(
            id=UUID(item.id), name=item.name, window_title_pattern=item.window_title_pattern,
            created_at=datetime.fromisoformat(item.created_at), updated_at=datetime.fromisoformat(item.updated_at),
            regions=[
                RecognitionRegion(
                    id=UUID(region.id), name=region.name, x=region.x, y=region.y,
                    width=region.width, height=region.height,
                    preprocess_mode=region.preprocess_mode, enabled=bool(region.enabled),
                ) for region in item.regions
            ],
            rules=[Repository._rule_record(rule) for rule in item.rules],
        )

    @staticmethod
    def _rule_record(rule: DanmakuRuleModel) -> DanmakuRule:
        return DanmakuRule(
            id=UUID(rule.id), match_type=rule.match_type, pattern=rule.pattern,
            template=rule.template, confidence=rule.confidence,
            cooldown_ms=rule.cooldown_ms, enabled=bool(rule.enabled),
        )


class EventWriter:
    def __init__(self, repository: Repository) -> None:
        self.repository = repository
        self.queue: asyncio.Queue[EventEnvelope] = asyncio.Queue(maxsize=500)
        self.task: asyncio.Task[None] | None = None
        self.last_error: str | None = None

    def start(self) -> None:
        self.repository.cleanup()
        self.task = asyncio.create_task(self._run(), name="sqlite-event-writer")

    async def enqueue(self, event: EventEnvelope) -> None:
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            self.last_error = "事件持久化队列已满"
            logger.error(self.last_error)

    async def stop(self) -> None:
        await self.queue.join()
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        while True:
            try:
                envelope = await asyncio.wait_for(self.queue.get(), timeout=3600)
            except TimeoutError:
                try:
                    await asyncio.to_thread(self.repository.cleanup)
                    self.last_error = None
                except Exception as exc:
                    self.last_error = str(exc)
                    logger.exception("SQLite 定期清理失败")
                continue
            try:
                await asyncio.to_thread(self.repository.persist_event, envelope)
                self.last_error = None
            except Exception as exc:
                self.last_error = str(exc)
                logger.exception("事件写入 SQLite 失败")
            finally:
                self.queue.task_done()
