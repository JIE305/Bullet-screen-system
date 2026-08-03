from __future__ import annotations

import asyncio
import secrets
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
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
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status,
)

from . import __version__
from .contracts import (
    FrameReceipt,
    ProfileCreate,
    ProfilePatch,
    ProfileRecord,
    SessionCreate,
    SessionRecord,
    WindowBounds,
    utc_now,
)
from .runtime import DummyRecognizer, EventHub, FrameItem, SessionManager
from .windows import get_window_bounds

MAX_IMAGE_BYTES = 1024 * 1024
MAX_FRAME_AGE = timedelta(seconds=2)


def create_app(
    token: str,
    shutdown_callback: Callable[[], None] | None = None,
    window_bounds_reader: Callable[[int], WindowBounds | None] = get_window_bounds,
) -> FastAPI:
    hub = EventHub()
    recognizer = DummyRecognizer()
    sessions = SessionManager(hub, recognizer)
    profiles: dict[UUID, ProfileRecord] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await sessions.close_all()

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

    async def require_token(
        supplied: Annotated[str | None, Header(alias="X-DaMu-Token")] = None,
    ) -> None:
        if supplied is None or not secrets.compare_digest(supplied, token):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    api = APIRouter(prefix="/api/v1", dependencies=[Depends(require_token)])

    @api.get("/health")
    async def health() -> dict[str, str]:
        return {
            "status": "ok",
            "api_version": "1",
            "app_version": __version__,
            "recognizer": recognizer.name,
            "storage": "memory",
        }

    @api.get("/windows/{hwnd}/bounds", response_model=WindowBounds)
    async def window_bounds(hwnd: int) -> WindowBounds:
        bounds = window_bounds_reader(hwnd)
        if bounds is None:
            raise HTTPException(status_code=404, detail="window_unavailable")
        return bounds

    @api.get("/profiles", response_model=list[ProfileRecord])
    async def list_profiles() -> list[ProfileRecord]:
        return list(profiles.values())

    @api.post(
        "/profiles", response_model=ProfileRecord, status_code=status.HTTP_201_CREATED
    )
    async def create_profile(payload: ProfileCreate) -> ProfileRecord:
        profile = ProfileRecord(**payload.model_dump())
        profiles[profile.id] = profile
        return profile

    def find_profile(profile_id: UUID) -> ProfileRecord:
        profile = profiles.get(profile_id)
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
        profile = find_profile(profile_id)
        changes = payload.model_dump(exclude_unset=True)
        updated = profile.model_copy(update={**changes, "updated_at": utc_now()})
        profiles[profile_id] = updated
        return updated

    @api.delete("/profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_profile(profile_id: UUID) -> None:
        find_profile(profile_id)
        del profiles[profile_id]

    @api.post(
        "/sessions", response_model=SessionRecord, status_code=status.HTTP_201_CREATED
    )
    async def start_session(payload: SessionCreate) -> SessionRecord:
        find_profile(payload.profile_id)
        return await sessions.start(payload)

    @api.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def stop_session(session_id: UUID) -> None:
        if not await sessions.stop(session_id):
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
        timestamp = (
            captured_at.replace(tzinfo=UTC)
            if captured_at.tzinfo is None
            else captured_at.astimezone(UTC)
        )
        if utc_now() - timestamp > MAX_FRAME_AGE:
            return FrameReceipt(
                accepted=False, frame_id=frame_id, reason="frame_expired"
            )
        dropped = sessions.enqueue(
            session_id,
            FrameItem(
                frame_id=frame_id,
                region_id=region_id,
                captured_at=timestamp,
                width=width,
                height=height,
                image=content,
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
