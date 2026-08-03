from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Awaitable, Callable
from uuid import UUID, uuid4

from fastapi import WebSocket

from .contracts import EventEnvelope, SessionCreate, SessionRecord, utc_now


class EventHub:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()

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


@dataclass(slots=True)
class FrameItem:
    frame_id: UUID
    region_id: UUID
    captured_at: datetime
    width: int
    height: int
    image: bytes


class DummyRecognizer:
    name = "dummy"

    async def recognize(self, frame: FrameItem) -> tuple[str, float]:
        # Keep a small asynchronous boundary so queue replacement is observable in tests.
        await asyncio.sleep(0.03)
        digest = hashlib.sha256(frame.image).hexdigest()[:8]
        return f"测试帧 {frame.width}×{frame.height} / {digest}", 1.0


@dataclass(slots=True)
class ActiveSession:
    record: SessionRecord
    queue: asyncio.Queue[FrameItem]
    worker: asyncio.Task[None]


class SessionManager:
    def __init__(self, hub: EventHub, recognizer: DummyRecognizer) -> None:
        self._hub = hub
        self._recognizer = recognizer
        self._sessions: dict[UUID, ActiveSession] = {}

    def get(self, session_id: UUID) -> ActiveSession | None:
        return self._sessions.get(session_id)

    async def start(self, request: SessionCreate) -> SessionRecord:
        record = SessionRecord(**request.model_dump())
        queue: asyncio.Queue[FrameItem] = asyncio.Queue(maxsize=1)
        worker = asyncio.create_task(
            self._run_worker(record, queue), name=f"frame-worker-{record.id}"
        )
        self._sessions[record.id] = ActiveSession(record, queue, worker)
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

    async def _run_worker(
        self, record: SessionRecord, queue: asyncio.Queue[FrameItem]
    ) -> None:
        while True:
            frame = await queue.get()
            try:
                text, confidence = await self._recognizer.recognize(frame)
                recognition_id = uuid4()
                await self._hub.publish(
                    EventEnvelope(
                        event_id=recognition_id,
                        type="recognition.detected",
                        session_id=record.id,
                        payload={
                            "region_id": str(frame.region_id),
                            "text": text,
                            "normalized_text": text.casefold(),
                            "confidence": confidence,
                            "observed_at": frame.captured_at.astimezone(UTC).isoformat(),
                            "content_hash": hashlib.sha256(text.encode()).hexdigest(),
                        },
                    )
                )
                now = utc_now()
                await self._hub.publish(
                    EventEnvelope(
                        type="danmaku.created",
                        session_id=record.id,
                        payload={
                            "message_id": str(uuid4()),
                            "recognition_event_id": str(recognition_id),
                            "text": f"链路已连通 · {text}",
                            "style": {"tone": "signal", "speed": "normal"},
                            "duration_ms": 7200,
                            "created_at": now.isoformat(),
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

