from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Awaitable, Callable
from uuid import UUID, uuid4

from fastapi import WebSocket

from .contracts import EventEnvelope, ProfileRecord, SessionCreate, SessionRecord, utc_now
from .recognition import RecognitionCandidate, Recognizer
from .rules import RuleEngine
from .generation import (
    DanmakuGenerationInput,
    DirectAiDanmakuGenerator,
    GenerationFailure,
    GenerationOutput,
    GenerationService,
)
from .rules import normalize_text


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
    rules: RuleEngine | None
    generator: DirectAiDanmakuGenerator | None


class SessionManager:
    def __init__(
        self,
        hub: EventHub,
        recognizer: Recognizer,
        session_sink: Callable[[SessionRecord], None] | None = None,
        generator_factory: Callable[[], DirectAiDanmakuGenerator] | None = None,
    ) -> None:
        self._hub = hub
        self._recognizer = recognizer
        self._sessions: dict[UUID, ActiveSession] = {}
        self._session_sink = session_sink
        default_generation = GenerationService()
        self._generator_factory = generator_factory or default_generation.create_generator

    def get(self, session_id: UUID) -> ActiveSession | None:
        return self._sessions.get(session_id)

    async def start(
        self,
        request: SessionCreate,
        profile: ProfileRecord,
    ) -> SessionRecord:
        record = SessionRecord(**request.model_dump())
        queue: asyncio.Queue[FrameItem] = asyncio.Queue(maxsize=1)
        rules = RuleEngine(profile.rules) if request.generation_mode == "profile_template" else None
        generator = self._generator_factory() if request.generation_mode == "ai" else None
        worker = asyncio.create_task(
            self._run_worker(record, queue, rules, generator, profile.game_name),
            name=f"frame-worker-{record.id}",
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
        if active.generator is not None:
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
        rules: RuleEngine | None,
        generator: DirectAiDanmakuGenerator | None,
        game_name: str | None,
    ) -> None:
        last_seen: dict[tuple[str, str], float] = {}
        while True:
            frame = await queue.get()
            started = time.perf_counter()
            try:
                candidates = await self._recognizer.recognize(
                    frame.image, frame.preprocess_mode
                )
                processing_ms = round((time.perf_counter() - started) * 1000, 2)
                if record.generation_mode == "profile_template":
                    assert rules is not None
                    for candidate in candidates:
                        accepted = rules.accept(str(frame.region_id), candidate)
                        if accepted is None:
                            continue
                        recognition_id = uuid4()
                        await self._hub.publish(
                            EventEnvelope(
                                event_id=recognition_id,
                                type="recognition.detected",
                                session_id=record.id,
                                payload={
                                    "region_id": str(frame.region_id),
                                    "text": candidate.text,
                                    "normalized_text": accepted.normalized_text,
                                    "confidence": candidate.confidence,
                                    "box": candidate.box,
                                    "observed_at": frame.captured_at.astimezone(UTC).isoformat(),
                                    "content_hash": hashlib.sha256(accepted.normalized_text.encode()).hexdigest(),
                                    "processing_ms": processing_ms,
                                    "generation_evaluation": {
                                        "status": "generated" if accepted.messages else "not_selected",
                                        "mode": "profile_template",
                                    },
                                },
                            )
                        )
                        for message in accepted.messages:
                            await self._publish_danmaku(
                                record,
                                recognition_id,
                                GenerationOutput(message.text, "template", 0),
                                processing_ms,
                                rule_id=message.rule_id,
                            )
                    continue

                assert generator is not None
                eligible: list[tuple[RecognitionCandidate, str, UUID]] = []
                current = time.monotonic()
                for candidate in candidates:
                    if candidate.confidence < generator.minimum_confidence:
                        continue
                    normalized = normalize_text(candidate.text)
                    if not normalized:
                        continue
                    dedupe_key = (str(frame.region_id), normalized)
                    previous = last_seen.get(dedupe_key)
                    if previous is not None and current - previous < 3:
                        continue
                    last_seen[dedupe_key] = current
                    eligible.append((candidate, normalized, uuid4()))

                if not eligible:
                    continue
                selected = max(eligible, key=lambda item: item[0].confidence)
                for candidate, normalized, recognition_id in eligible:
                    payload = {
                        "region_id": str(frame.region_id),
                        "text": candidate.text,
                        "normalized_text": normalized,
                        "confidence": candidate.confidence,
                        "box": candidate.box,
                        "observed_at": frame.captured_at.astimezone(UTC).isoformat(),
                        "content_hash": hashlib.sha256(normalized.encode()).hexdigest(),
                        "processing_ms": processing_ms,
                    }
                    if recognition_id != selected[2]:
                        await self._publish_recognition(
                            record, recognition_id, payload, "not_selected"
                        )
                        continue

                    if not generator.configured:
                        await self._publish_recognition(
                            record, recognition_id, payload, "cloud_unavailable"
                        )
                        continue
                    generation_input = DanmakuGenerationInput(
                        game_name=game_name,
                        ocr_text=candidate.text,
                    )
                    limited = await generator.reserve(generation_input)
                    if limited:
                        await self._publish_recognition(
                            record, recognition_id, payload, limited
                        )
                        continue
                    await self._publish_recognition(record, recognition_id, payload, "calling")
                    try:
                        generated = await generator.generate_reserved(generation_input)
                    except GenerationFailure as exc:
                        final_status = (
                            exc.reason
                            if exc.reason in {"interval_limited", "repeat_limited", "rate_limited"}
                            else "failed"
                        )
                        await self._publish_recognition(
                            record,
                            recognition_id,
                            payload,
                            final_status,
                            reason=exc.reason,
                        )
                        continue
                    await self._publish_recognition(record, recognition_id, payload, "generated")
                    await self._publish_danmaku(
                        record, recognition_id, generated, processing_ms, rule_id=None
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

    async def _publish_recognition(
        self,
        record: SessionRecord,
        recognition_id: UUID,
        payload: dict[str, object],
        status: str,
        *,
        reason: str | None = None,
    ) -> None:
        await self._hub.publish(
            EventEnvelope(
                event_id=recognition_id,
                type="recognition.detected",
                session_id=record.id,
                payload={
                    **payload,
                    "generation_evaluation": {
                        "status": status,
                        "mode": "ai",
                        **({"reason": reason} if reason else {}),
                    },
                },
            )
        )

    async def _publish_danmaku(
        self,
        record: SessionRecord,
        recognition_id: UUID,
        generated: GenerationOutput,
        processing_ms: float,
        *,
        rule_id: str | None,
    ) -> None:
        now = utc_now()
        await self._hub.publish(
            EventEnvelope(
                type="danmaku.created",
                session_id=record.id,
                payload={
                    "message_id": str(uuid4()),
                    "recognition_event_id": str(recognition_id),
                    "rule_id": rule_id,
                    "text": generated.text,
                    "style": {"tone": "signal", "speed": "normal"},
                    "duration_ms": 7200,
                    "created_at": now.isoformat(),
                    "processing_ms": processing_ms,
                    "generator": generated.generator,
                    "generation_ms": generated.generation_ms,
                    **({"model": generated.model} if generated.model else {}),
                    **(
                        {"provider_request_id": generated.provider_request_id}
                        if generated.provider_request_id
                        else {}
                    ),
                },
            )
        )
