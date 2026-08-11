from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Awaitable, Callable
from uuid import UUID, uuid4

from fastapi import WebSocket

from .contracts import DanmakuRule, EventEnvelope, ProfileRecord, SessionCreate, SessionRecord, utc_now
from .recognition import Recognizer
from .rules import RuleEngine
from .generation import DanmakuGenerator, FallbackDanmakuGenerator


class EventHub:
    def __init__(
        self, sink: Callable[[EventEnvelope], Awaitable[None]] | None = None
    ) -> None:
        self._connections: set[WebSocket] = set()
        self._sink = sink

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self._connections.discard(websocket)

    async def publish(self, event: EventEnvelope) -> None:
        message = event.model_dump(mode="json")
        failed: list[WebSocket] = []
        for websocket in tuple(self._connections):
            try:
                await websocket.send_json(message)
            except Exception:
                failed.append(websocket)
        for websocket in failed:
            self.disconnect(websocket)
        if self._sink is not None:
            await self._sink(event)


@dataclass(slots=True)
class FrameItem:
    frame_id: UUID
    region_id: UUID
    captured_at: datetime
    width: int
    height: int
    image: bytes
    preprocess_mode: str = "original"


@dataclass(slots=True)
class ActiveSession:
    record: SessionRecord
    queue: asyncio.Queue[FrameItem]
    worker: asyncio.Task[None]
    rules: RuleEngine
    generator: DanmakuGenerator


class SessionManager:
    def __init__(
        self,
        hub: EventHub,
        recognizer: Recognizer,
        session_sink: Callable[[SessionRecord], None] | None = None,
        generator_factory: Callable[[], DanmakuGenerator] | None = None,
    ) -> None:
        self._hub = hub
        self._recognizer = recognizer
        self._sessions: dict[UUID, ActiveSession] = {}
        self._session_sink = session_sink
        self._generator_factory = generator_factory or (lambda: FallbackDanmakuGenerator(None))

    def get(self, session_id: UUID) -> ActiveSession | None:
        return self._sessions.get(session_id)

    async def start(
        self,
        request: SessionCreate,
        profile: ProfileRecord,
        selected_rules: list[DanmakuRule] | None = None,
    ) -> SessionRecord:
        record = SessionRecord(**request.model_dump())
        queue: asyncio.Queue[FrameItem] = asyncio.Queue(maxsize=1)
        rules = RuleEngine(profile.rules if selected_rules is None else selected_rules)
        generator = self._generator_factory()
        worker = asyncio.create_task(
            self._run_worker(record, queue, rules, generator), name=f"frame-worker-{record.id}"
        )
        self._sessions[record.id] = ActiveSession(record, queue, worker, rules, generator)
        if self._session_sink is not None:
            await asyncio.to_thread(self._session_sink, record)
        await self._hub.publish(
            EventEnvelope(
                type="session.status",
                session_id=record.id,
                payload={"status": "running", "window_name": record.window_name},
            )
        )
        return record

    async def stop(self, session_id: UUID, reason: str = "user_requested") -> bool:
        active = self._sessions.pop(session_id, None)
        if active is None:
            return False
        active.record.status = "stopped"
        active.record.ended_at = utc_now()
        active.record.end_reason = reason
        active.worker.cancel()
        try:
            await active.worker
        except asyncio.CancelledError:
            pass
        await active.generator.close()
        if self._session_sink is not None:
            await asyncio.to_thread(self._session_sink, active.record)
        await self._hub.publish(
            EventEnvelope(
                type="session.status",
                session_id=session_id,
                payload={"status": "stopped", "reason": reason},
            )
        )
        return True

    def enqueue(self, session_id: UUID, frame: FrameItem) -> UUID | None:
        active = self._sessions.get(session_id)
        if active is None:
            raise KeyError(session_id)
        dropped: UUID | None = None
        if active.queue.full():
            old_frame = active.queue.get_nowait()
            active.queue.task_done()
            dropped = old_frame.frame_id
        active.queue.put_nowait(frame)
        return dropped

    async def close_all(self) -> None:
        for session_id in tuple(self._sessions):
            await self.stop(session_id, "backend_shutdown")
        await self._recognizer.close()

    async def _run_worker(
        self,
        record: SessionRecord,
        queue: asyncio.Queue[FrameItem],
        rules: RuleEngine,
        generator: DanmakuGenerator,
    ) -> None:
        while True:
            frame = await queue.get()
            started = time.perf_counter()
            try:
                candidates = await self._recognizer.recognize(
                    frame.image, frame.preprocess_mode
                )
                processing_ms = round((time.perf_counter() - started) * 1000, 2)
                for candidate in candidates:
                    accepted = rules.accept(str(frame.region_id), candidate)
                    if accepted is None:
                        continue
                    normalized = accepted.normalized_text
                    messages = accepted.messages
                    recognition_id = uuid4()
                    await self._hub.publish(
                        EventEnvelope(
                            event_id=recognition_id,
                            type="recognition.detected",
                            session_id=record.id,
                            payload={
                                "region_id": str(frame.region_id),
                                "text": candidate.text,
                                "normalized_text": normalized,
                                "confidence": candidate.confidence,
                                "box": candidate.box,
                                "observed_at": frame.captured_at.astimezone(UTC).isoformat(),
                                "content_hash": hashlib.sha256(normalized.encode()).hexdigest(),
                                "processing_ms": processing_ms,
                                "rule_evaluation": {
                                    "status": accepted.status,
                                    "configured_rule_count": len(accepted.checks),
                                    "matched_rule_count": accepted.matched_rule_count,
                                    "emitted_message_count": len(messages),
                                    "checks": [
                                        {
                                            "rule_id": check.rule_id,
                                            "match_type": check.match_type,
                                            "pattern": check.pattern,
                                            "status": check.status,
                                        }
                                        for check in accepted.checks
                                    ],
                                },
                            },
                        )
                    )
                    for message in messages:
                        generated = await generator.generate(candidate.text, message.text)
                        now = utc_now()
                        await self._hub.publish(
                            EventEnvelope(
                                type="danmaku.created",
                                session_id=record.id,
                                payload={
                                    "message_id": str(uuid4()),
                                    "recognition_event_id": str(recognition_id),
                                    "rule_id": message.rule_id,
                                    "text": generated.text,
                                    "style": {"tone": "signal", "speed": "normal"},
                                    "duration_ms": 7200,
                                    "created_at": now.isoformat(),
                                    "processing_ms": processing_ms,
                                    "generator": generated.generator,
                                    "generation_ms": generated.generation_ms,
                                    **(
                                        {"fallback_reason": generated.fallback_reason}
                                        if generated.fallback_reason
                                        else {}
                                    ),
                                    **({"model": generated.model} if generated.model else {}),
                                    **(
                                        {"provider_request_id": generated.provider_request_id}
                                        if generated.provider_request_id
                                        else {}
                                    ),
                                },
                            )
                        )
            except Exception as exc:
                await self._hub.publish(
                    EventEnvelope(
                        type="error",
                        session_id=record.id,
                        payload={"code": "recognizer_failed", "message": str(exc)},
                    )
                )
            finally:
                queue.task_done()
