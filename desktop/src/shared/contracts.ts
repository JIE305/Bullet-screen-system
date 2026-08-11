import type { OverlayStyleSettings } from './overlay-style'
import type { CaptureStartOptions, PreprocessMode, RoiSettings, SavedCaptureSettings } from './capture-settings'
import type {
  CloudApiPublicSettings,
  CloudApiRuntimeState,
  CloudApiSettingsUpdate
} from './cloud-api'

export type BackendStatus = 'starting' | 'online' | 'offline' | 'error'
export type SessionStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

export interface AppState {
  backend: BackendStatus
  connection: 'connected' | 'disconnected'
  session: SessionStatus
  sessionId?: string
  activeWindow?: string
  framesAccepted: number
  framesDropped: number
  lastEvent?: string
  error?: string
}

export interface CaptureSourceInfo {
  id: string
  name: string
  thumbnail: string
}

export type EventType =
  | 'session.status'
  | 'recognition.detected'
  | 'danmaku.created'
  | 'window.bounds_changed'
  | 'error'

export interface EventEnvelope {
  schema_version: '1'
  event_id: string
  type: EventType
  session_id?: string
  emitted_at: string
  payload: Record<string, unknown>
}

export interface CaptureRuntime {
  sessionId: string
  regionId: string
  region: RoiSettings
  preprocessMode: PreprocessMode
}

export interface FrameUpload {
  sessionId: string
  regionId: string
  frameId: string
  capturedAt: string
  width: number
  height: number
  bytes: ArrayBuffer
}

export interface FrameReceipt {
  accepted: boolean
  frame_id: string
  reason?: string
  dropped_frame_id?: string
}

export interface DaMuApi {
  getState(): Promise<AppState>
  listSources(): Promise<CaptureSourceInfo[]>
  startDemo(): Promise<void>
  startSource(options: CaptureStartOptions): Promise<void>
  getCaptureSettings(sourceId: string): Promise<SavedCaptureSettings | null>
  getCloudApiSettings(): Promise<CloudApiPublicSettings>
  saveCloudApiSettings(input: CloudApiSettingsUpdate): Promise<CloudApiPublicSettings>
  stopSession(): Promise<void>
  sendOverlayTest(): Promise<void>
  copyText(text: string): Promise<void>
  getOverlayStyle(): Promise<OverlayStyleSettings>
  updateOverlayStyle(settings: OverlayStyleSettings): Promise<OverlayStyleSettings>
  notifyOverlayStyleReady(): void
  getCaptureRuntime(): Promise<CaptureRuntime | null>
  uploadFrame(payload: FrameUpload): Promise<FrameReceipt>
  onState(callback: (state: AppState) => void): () => void
  onEvent(callback: (event: EventEnvelope) => void): () => void
  onOverlayReset(callback: () => void): () => void
  onOverlayStyle(callback: (settings: OverlayStyleSettings) => void): () => void
  onCloudApiState(callback: (state: CloudApiRuntimeState) => void): () => void
}
