import type { AppState, CaptureSourceInfo, DaMuApi, EventEnvelope } from '../../shared/contracts'
import {
  cloneDefaultOverlayStyle,
  parseOverlayStyleSettings,
  type OverlayStyleSettings
} from '../../shared/overlay-style'

const stateCallbacks = new Set<(state: AppState) => void>()
const eventCallbacks = new Set<(event: EventEnvelope) => void>()
const overlayResetCallbacks = new Set<() => void>()
const overlayStyleCallbacks = new Set<(settings: OverlayStyleSettings) => void>()
let mockOverlayStyle = cloneDefaultOverlayStyle()
let mockState: AppState = {
  backend: 'online',
  connection: 'connected',
  session: 'idle',
  framesAccepted: 0,
  framesDropped: 0,
  lastEvent: '浏览器预览模式'
}

function emitMockState(patch: Partial<AppState>): void {
  mockState = { ...mockState, ...patch }
  for (const callback of stateCallbacks) callback({ ...mockState })
}

function emitMockEvent(event: EventEnvelope): void {
  for (const callback of eventCallbacks) callback(event)
}

const browserPreviewApi: DaMuApi = {
  getState: async () => ({ ...mockState }),
  listSources: async (): Promise<CaptureSourceInfo[]> => [
    { id: 'preview:test-scene', name: 'DaMu Test Scene', thumbnail: '' }
  ],
  startDemo: async () => {
    emitMockState({ session: 'starting', activeWindow: 'DaMu Test Scene', error: undefined })
    window.setTimeout(() => {
      emitMockState({
        session: 'running',
        sessionId: 'preview-session',
        framesAccepted: mockState.framesAccepted + 1,
        lastEvent: 'danmaku.created'
      })
      emitMockEvent({
        schema_version: '1',
        event_id: crypto.randomUUID(),
        type: 'danmaku.created',
        session_id: 'preview-session',
        emitted_at: new Date().toISOString(),
        payload: { text: '浏览器预览链路已启动', duration_ms: 5200 }
      })
    }, 350)
  },
  startSource: async () => browserPreviewApi.startDemo(),
  stopSession: async () => {
    for (const callback of overlayResetCallbacks) callback()
    emitMockState({ session: 'idle', sessionId: undefined, activeWindow: undefined })
  },
  sendOverlayTest: async () => {
    emitMockState({ lastEvent: 'danmaku.created' })
    emitMockEvent({
      schema_version: '1',
      event_id: crypto.randomUUID(),
      type: 'danmaku.created',
      emitted_at: new Date().toISOString(),
      payload: { text: '覆盖层自检通过', duration_ms: 5200 }
    })
  },
  copyText: async (text) => {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入')
    await navigator.clipboard.writeText(text)
  },
  getOverlayStyle: async () => ({ ...mockOverlayStyle }),
  updateOverlayStyle: async (settings) => {
    mockOverlayStyle = parseOverlayStyleSettings(settings)
    for (const callback of overlayStyleCallbacks) callback({ ...mockOverlayStyle })
    return { ...mockOverlayStyle }
  },
  notifyOverlayStyleReady: () => undefined,
  getCaptureRuntime: async () => null,
  uploadFrame: async (payload) => ({ accepted: true, frame_id: payload.frameId }),
  onState: (callback) => {
    stateCallbacks.add(callback)
    return () => stateCallbacks.delete(callback)
  },
  onEvent: (callback) => {
    eventCallbacks.add(callback)
    return () => eventCallbacks.delete(callback)
  },
  onOverlayReset: (callback) => {
    overlayResetCallbacks.add(callback)
    return () => overlayResetCallbacks.delete(callback)
  },
  onOverlayStyle: (callback) => {
    overlayStyleCallbacks.add(callback)
    return () => overlayStyleCallbacks.delete(callback)
  }
}

export const damuApi: DaMuApi = window.damu ?? browserPreviewApi
export const isBrowserPreview = !window.damu
