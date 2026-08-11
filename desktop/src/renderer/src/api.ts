import type { AppState, CaptureSourceInfo, DaMuApi, EventEnvelope } from '../../shared/contracts'
import {
  cloneDefaultOverlayStyle,
  parseOverlayStyleSettings,
  type OverlayStyleSettings
} from '../../shared/overlay-style'
import {
  cloneDefaultCloudApiSettings,
  type CloudApiRuntimeState
} from '../../shared/cloud-api'

const stateCallbacks = new Set<(state: AppState) => void>()
const eventCallbacks = new Set<(event: EventEnvelope) => void>()
const overlayResetCallbacks = new Set<() => void>()
const overlayStyleCallbacks = new Set<(settings: OverlayStyleSettings) => void>()
const cloudApiStateCallbacks = new Set<(state: CloudApiRuntimeState) => void>()
let mockOverlayStyle = cloneDefaultOverlayStyle()
let mockCloudSettings = cloneDefaultCloudApiSettings()
let mockCloudState: CloudApiRuntimeState = { status: 'unconfigured' }
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
  getCaptureSettings: async () => null,
  getCloudApiSettings: async () => ({ ...mockCloudSettings }),
  saveCloudApiSettings: async (input) => {
    const hasApiKey = input.deleteApiKey ? false : Boolean(input.apiKey) || mockCloudSettings.hasApiKey
    mockCloudSettings = {
      schemaVersion: 3,
      enabled: input.enabled && hasApiKey,
      baseUrl: input.baseUrl,
      model: input.model,
      systemPrompt: input.systemPrompt,
      timeoutMs: input.timeoutMs,
      minConfidence: input.minConfidence,
      minIntervalMs: input.minIntervalMs,
      repeatCooldownMs: input.repeatCooldownMs,
      maxCallsPerMinute: input.maxCallsPerMinute,
      hasApiKey,
      secretStorage: hasApiKey ? 'memory' : 'none'
    }
    mockCloudState = {
      status: mockCloudSettings.enabled ? 'ready' : hasApiKey ? 'disabled' : 'unconfigured',
      model: mockCloudSettings.model
    }
    for (const callback of cloudApiStateCallbacks) callback({ ...mockCloudState })
    return { ...mockCloudSettings }
  },
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
  },
  onCloudApiState: (callback) => {
    cloudApiStateCallbacks.add(callback)
    callback({ ...mockCloudState })
    return () => cloudApiStateCallbacks.delete(callback)
  }
}

export const damuApi: DaMuApi = window.damu ?? browserPreviewApi
export const isBrowserPreview = !window.damu
