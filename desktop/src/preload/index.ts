import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState,
  CaptureRuntime,
  CaptureSourceInfo,
  DaMuApi,
  EventEnvelope,
  FrameReceipt,
  FrameUpload
} from '../shared/contracts'
import type { OverlayStyleSettings } from '../shared/overlay-style'

const api: DaMuApi = {
  getState: () => ipcRenderer.invoke('damu:get-state') as Promise<AppState>,
  listSources: () => ipcRenderer.invoke('damu:list-sources') as Promise<CaptureSourceInfo[]>,
  startDemo: () => ipcRenderer.invoke('damu:start-demo') as Promise<void>,
  startSource: (sourceId) => ipcRenderer.invoke('damu:start-source', sourceId) as Promise<void>,
  stopSession: () => ipcRenderer.invoke('damu:stop-session') as Promise<void>,
  sendOverlayTest: () => ipcRenderer.invoke('damu:overlay-test') as Promise<void>,
  copyText: (text) => ipcRenderer.invoke('damu:copy-text', text) as Promise<void>,
  getOverlayStyle: () =>
    ipcRenderer.invoke('damu:get-overlay-style') as Promise<OverlayStyleSettings>,
  updateOverlayStyle: (settings) =>
    ipcRenderer.invoke('damu:update-overlay-style', settings) as Promise<OverlayStyleSettings>,
  notifyOverlayStyleReady: () => ipcRenderer.send('damu:overlay-style-ready'),
  getCaptureRuntime: () =>
    ipcRenderer.invoke('damu:get-capture-runtime') as Promise<CaptureRuntime | null>,
  uploadFrame: (payload: FrameUpload) =>
    ipcRenderer.invoke('damu:upload-frame', payload) as Promise<FrameReceipt>,
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState): void => callback(state)
    ipcRenderer.on('damu:state', listener)
    return () => ipcRenderer.removeListener('damu:state', listener)
  },
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: EventEnvelope): void =>
      callback(envelope)
    ipcRenderer.on('damu:event', listener)
    return () => ipcRenderer.removeListener('damu:event', listener)
  },
  onOverlayReset: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('damu:overlay-reset', listener)
    return () => ipcRenderer.removeListener('damu:overlay-reset', listener)
  },
  onOverlayStyle: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: OverlayStyleSettings): void =>
      callback(settings)
    ipcRenderer.on('damu:overlay-style', listener)
    return () => ipcRenderer.removeListener('damu:overlay-style', listener)
  }
}

contextBridge.exposeInMainWorld('damu', api)
