from __future__ import annotations

import asyncio
import secrets
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Callable
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status,
)

from . import __version__
from .contracts import (
    DanmakuRule,
    GenerationConfig,
    GenerationConfigState,
    GenerationTestRequest,
    GenerationTestResult,
    FrameReceipt,
    ProfileCreate,
    ProfilePatch,
    ProfileRecord,
    SessionCreate,
    SessionRecord,
    WindowBounds,
    utc_now,
)
from .recognition import DummyRecognizer, Recognizer
from .database import EventWriter, Repository
from .runtime import EventHub, FrameItem, SessionManager
from .generation import GenerationFailure, GenerationService
from .windows import get_window_bounds

MAX_IMAGE_BYTES = 1024 * 1024
MAX_FRAME_AGE = timedelta(seconds=2)


def create_app(
    token: str,
    shutdown_callback: Callable[[], None] | None = None,
    window_bounds_reader: Callable[[int], WindowBounds | None] = get_window_bounds,
    recognizer: Recognizer | None = None,
    data_dir: Path | None = None,
    generation_service: GenerationService | None = None,
) -> FastAPI:
    repository = Repository(data_dir / "damusystem.sqlite3") if data_dir else None
    writer = EventWriter(repository) if repository else None
    hub = EventHub(writer.enqueue if writer else None)
    active_recognizer = recognizer or DummyRecognizer()
    generation = generation_service or GenerationService()
    sessions = SessionManager(
        hub,
        active_recognizer,
        repository.save_session if repository else None,
        generation.create_generator,
    )
    profiles: dict[UUID, ProfileRecord] = {}
    global_rules: list[DanmakuRule] = []

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if writer:
            writer.start()
        try:
            yield
        finally:
            await sessions.close_all()
            if writer:
                await writer.stop()
            if repository:
                repository.close()

    app = FastAPI(
        title="DaMuSystem Local Backend",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )
    app.state.event_hub = hub
    app.state.session_manager = sessions
    app.state.profiles = profiles
    app.state.global_rules = global_rules
    app.state.repository = repository
    app.state.event_writer = writer
    app.state.generation_service = generation

    async def require_token(
        supplied: Annotated[str | None, Header(alias="X-DaMu-Token")] = None,
    ) -> None:
        if supplied is None or not secrets.compare_digest(supplied, token):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    api = APIRouter(prefix="/api/v1", dependencies=[Depends(require_token)])

    @api.get("/health")
    async def health() -> dict[str, str | None]:
        return {
            "status": "ok",
            "api_version": "1",
            "app_version": __version__,
            "recognizer": active_recognizer.name,
            "storage": "sqlite" if repository else "memory",
            "database": "error" if writer and writer.last_error else "ok",
            "database_error": writer.last_error if writer else None,
        }

    @api.get("/windows/{hwnd}/bounds", response_model=WindowBounds)
    async def window_bounds(hwnd: int) -> WindowBounds:
        bounds = window_bounds_reader(hwnd)
        if bounds is None:
            raise HTTPException(status_code=404, detail="window_unavailable")
        return bounds

    @api.get("/profiles", response_model=list[ProfileRecord])
    async def list_profiles() -> list[ProfileRecord]:
        if repository:
            return await asyncio.to_thread(repository.list_profiles)
        return list(profiles.values())

    @api.post(
        "/profiles", response_model=ProfileRecord, status_code=status.HTTP_201_CREATED
    )
    async def create_profile(payload: ProfileCreate) -> ProfileRecord:
        if repository:
            return await asyncio.to_thread(repository.create_profile, payload)
        profile = ProfileRecord(**payload.model_dump())
        profiles[profile.id] = profile
        return profile

    def find_profile(profile_id: UUID) -> ProfileRecord:
        profile = repository.get_profile(profile_id) if repository else profiles.get(profile_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="profile_not_found")
        return profile

    @api.get("/profiles/{profile_id}", response_model=ProfileRecord)
    async def get_profile(profile_id: UUID) -> ProfileRecord:
        return find_profile(profile_id)

    @api.patch("/profiles/{profile_id}", response_model=ProfileRecord)
    async def patch_profile(
        profile_id: UUID, payload: ProfilePatch
    ) -> ProfileRecord:
        if repository:
            updated = await asyncio.to_thread(repository.patch_profile, profile_id, payload)
            if updated is None:
                raise HTTPException(status_code=404, detail="profile_not_found")
            return updated
        profile = find_profile(profile_id)
        changes = payload.model_dump(exclude_unset=True)
        updated = profile.model_copy(update={**changes, "updated_at": utc_now()})
        profiles[profile_id] = updated
        return updated

    @api.delete("/profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_profile(profile_id: UUID) -> None:
        if repository:
            deleted = await asyncio.to_thread(repository.delete_profile, profile_id)
            if not deleted:
                raise HTTPException(status_code=404, detail="profile_not_found")
            return
        find_profile(profile_id)
        del profiles[profile_id]

    @api.get("/rules/global", response_model=list[DanmakuRule])
    async def list_global_rules() -> list[DanmakuRule]:
        if repository:
            return await asyncio.to_thread(repository.list_global_rules)
        return list(global_rules)

    @api.put("/rules/global", response_model=list[DanmakuRule])
    async def replace_global_rules(payload: list[DanmakuRule]) -> list[DanmakuRule]:
        if repository:
            return await asyncio.to_thread(repository.replace_global_rules, payload)
        global_rules[:] = payload
        return list(global_rules)

    @api.put("/generation/config", response_model=GenerationConfigState)
    async def configure_generation(payload: GenerationConfig) -> GenerationConfigState:
        generation.configure(payload)
        return GenerationConfigState(
            enabled=payload.enabled,
            configured=generation.configured,
            model=payload.model,
        )

    @api.post("/generation/test", response_model=GenerationTestResult)
    async def test_generation(payload: GenerationTestRequest) -> GenerationTestResult:
        try:
            return await generation.test(payload.text, payload.local_text)
        except GenerationFailure as exc:
            raise HTTPException(status_code=502, detail=exc.reason) from exc

    @api.post(
        "/sessions", response_model=SessionRecord, status_code=status.HTTP_201_CREATED
    )
    async def start_session(payload: SessionCreate) -> SessionRecord:
        profile = find_profile(payload.profile_id)
        selected_rules: list[DanmakuRule] | None = None
        if payload.rule_scope == "global":
            selected_rules = (
                await asyncio.to_thread(repository.list_global_rules)
                if repository
                else list(global_rules)
            )
        return await sessions.start(payload, profile, selected_rules)

    @api.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def stop_session(
        session_id: UUID,
        reason: Annotated[str, Query(min_length=1, max_length=80)] = "user_requested",
    ) -> None:
        if not await sessions.stop(session_id, reason):
            raise HTTPException(status_code=404, detail="session_not_found")

    @api.post(
        "/sessions/{session_id}/frames",
        response_model=FrameReceipt,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def upload_frame(
        session_id: UUID,
        frame_id: Annotated[UUID, Form()],
        region_id: Annotated[UUID, Form()],
        captured_at: Annotated[datetime, Form()],
        width: Annotated[int, Form(ge=1, le=7680)],
        height: Annotated[int, Form(ge=1, le=4320)],
        image: Annotated[UploadFile, File()],
    ) -> FrameReceipt:
        if sessions.get(session_id) is None:
            raise HTTPException(status_code=404, detail="session_not_found")
        if image.content_type != "image/jpeg":
            raise HTTPException(status_code=415, detail="jpeg_required")
        content = await image.read(MAX_IMAGE_BYTES + 1)
        if len(content) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="frame_too_large")
        if len(content) < 4 or not content.startswith(b"\xff\xd8") or not content.endswith(b"\xff\xd9"):
            raise HTTPException(status_code=422, detail="invalid_jpeg")
        timestamp = (
            captured_at.replace(tzinfo=UTC)
            if captured_at.tzinfo is None
            else captured_at.astimezone(UTC)
        )
        if utc_now() - timestamp > MAX_FRAME_AGE:
            return FrameReceipt(
                accepted=False, frame_id=frame_id, reason="frame_expired"
            )
        profile = find_profile(sessions.get(session_id).record.profile_id)
        region = next((item for item in profile.regions if item.id == region_id), None)
        if region is None or not region.enabled:
            raise HTTPException(status_code=422, detail="region_unavailable")
        dropped = sessions.enqueue(
            session_id,
            FrameItem(
                frame_id=frame_id,
                region_id=region_id,
                captured_at=timestamp,
                width=width,
                height=height,
                image=content,
                preprocess_mode=region.preprocess_mode,
            ),
        )
        return FrameReceipt(
            accepted=True, frame_id=frame_id, dropped_frame_id=dropped
        )

    @app.websocket("/ws/v1/events")
    async def websocket_events(websocket: WebSocket) -> None:
        supplied = websocket.headers.get("x-damu-token")
        if supplied is None or not secrets.compare_digest(supplied, token):
            await websocket.close(code=4401)
            return
        await hub.connect(websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            hub.disconnect(websocket)

    async def delayed_shutdown() -> None:
        await asyncio.sleep(0.05)
        if shutdown_callback is not None:
            shutdown_callback()

    @api.post("/shutdown", status_code=status.HTTP_202_ACCEPTED)
    async def shutdown(background_tasks: BackgroundTasks) -> dict[str, str]:
        background_tasks.add_task(delayed_shutdown)
        return {"status": "shutting_down"}

    app.include_router(api)
    return app
