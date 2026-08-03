from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


EventType = Literal[
    "session.status",
    "recognition.detected",
    "danmaku.created",
    "window.bounds_changed",
    "error",
]


def utc_now() -> datetime:
    return datetime.now(UTC)


class EventEnvelope(BaseModel):
    schema_version: Literal["1"] = "1"
    event_id: UUID = Field(default_factory=uuid4)
    type: EventType
    session_id: UUID | None = None
    emitted_at: datetime = Field(default_factory=utc_now)
    payload: dict[str, Any]


class RecognitionRegion(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    name: str = Field(default="全画面测试区域", min_length=1, max_length=80)
    x: float = Field(default=0, ge=0, le=1)
    y: float = Field(default=0, ge=0, le=1)
    width: float = Field(default=1, gt=0, le=1)
    height: float = Field(default=1, gt=0, le=1)
    enabled: bool = True


class DanmakuRule(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    match_type: Literal["contains", "exact"] = "contains"
    pattern: str = "测试"
    template: str = "链路已连通 · {text}"
    confidence: float = Field(default=0.65, ge=0, le=1)
    cooldown_ms: int = Field(default=5000, ge=0, le=60000)
    enabled: bool = True


class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    window_title_pattern: str | None = Field(default=None, max_length=200)
    regions: list[RecognitionRegion] = Field(
        default_factory=lambda: [RecognitionRegion()]
    )
    rules: list[DanmakuRule] = Field(default_factory=lambda: [DanmakuRule()])


class ProfilePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    window_title_pattern: str | None = Field(default=None, max_length=200)
    regions: list[RecognitionRegion] | None = None
    rules: list[DanmakuRule] | None = None


class ProfileRecord(ProfileCreate):
    id: UUID = Field(default_factory=uuid4)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SessionCreate(BaseModel):
    profile_id: UUID
    source_id: str = Field(min_length=1, max_length=240)
    hwnd: int | None = Field(default=None, ge=0)
    window_name: str = Field(min_length=1, max_length=240)


class SessionRecord(SessionCreate):
    id: UUID = Field(default_factory=uuid4)
    status: Literal["running", "stopped"] = "running"
    started_at: datetime = Field(default_factory=utc_now)
    ended_at: datetime | None = None
    end_reason: str | None = None


class FrameReceipt(BaseModel):
    accepted: bool
    frame_id: UUID
    reason: str | None = None
    dropped_frame_id: UUID | None = None


class WindowBounds(BaseModel):
    x: int
    y: int
    width: int = Field(gt=0)
    height: int = Field(gt=0)
