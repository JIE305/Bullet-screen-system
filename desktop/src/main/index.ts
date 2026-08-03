import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  screen,
  session,
  type DesktopCapturerSource
} from 'electron'
import { BackendClient } from './backend-client'
import { OverlayStyleStore } from './overlay-style-store'
import type {
  AppState,
  CaptureRuntime,
  CaptureSourceInfo,
  EventEnvelope,
  FrameReceipt,
  FrameUpload
} from '../shared/contracts'
import { assertClipboardText, assertFrameUpload, assertSourceId } from '../shared/ipc-validation'
import { shouldForwardEventToOverlay } from '../shared/overlay-events'
import { disposeOverlayWindow } from '../shared/overlay-lifecycle'
import {
  cloneDefaultOverlayStyle,
  type OverlayStyleSettings
} from '../shared/overlay-style'
import { restoreOverlayZOrder } from '../shared/overlay-z-order'
import { boundsEqual, type WindowBoundsLike } from '../shared/window-bounds'

interface ProfileResponse {
  id: string
  name: string
  regions: Array<{ id: string }>
}

interface SessionResponse {
  id: string
}

const backend = new BackendClient()
let controlWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let captureWindow: BrowserWindow | null = null
let fixtureWindow: BrowserWindow | null = null
let approvedSourceId: string | null = null
let captureRuntime: CaptureRuntime | null = null
let shutdownStarted = false
let backendRestarted = false
let windowBoundsTimer: NodeJS.Timeout | null = null
let windowBoundsRequestPending = false
let windowBoundsGeneration = 0
let lastOverlayBounds: WindowBoundsLike | undefined
let overlayStyle = cloneDefaultOverlayStyle()
let overlayStyleStore: OverlayStyleStore | null = null
const automatedDemo = process.env.DAMU_AUTOMATED_DEMO === '1'
const automatedResultPath = process.env.DAMU_AUTOMATED_RESULT
let automatedStage: 'first' | 'restarting' | 'second' | 'finished' = 'first'
let automatedFirstOverlayId: number | undefined
let automatedOldOverlayDestroyed = false
let automatedOldMessageCount = 0
let automatedLiveStyleApplied = false

interface AutomatedComputedStyle {
  fontSize: string
  fontWeight: string
  color: string
  backgroundColor: string
}

interface EventManagementSmokeResult {
  filterVerified: boolean
  copyVerified: boolean
  removeVerified: boolean
  filteredClearVerified: boolean
}

function finishAutomatedDemo(status: 'ok' | 'error', payload: Record<string, unknown>): void {
  if (automatedStage === 'finished') return
  automatedStage = 'finished'
  const result = JSON.stringify({ status, ...payload })
  console.info(`DAMU_AUTOMATED_DEMO_${status.toUpperCase()} ${result}`)
  if (automatedResultPath) writeFileSync(automatedResultPath, result, 'utf8')
  setTimeout(() => app.quit(), 100)
}

async function countOverlayMessages(window: BrowserWindow): Promise<number> {
  if (window.isDestroyed()) return 0
  return window.webContents.executeJavaScript(
    "document.querySelectorAll('.danmaku-message').length",
    true
  ) as Promise<number>
}

async function readAutomatedComputedStyle(window: BrowserWindow): Promise<AutomatedComputedStyle> {
  if (window.isDestroyed()) throw new Error('覆盖层已销毁，无法读取样式')
  return window.webContents.executeJavaScript(
    `(() => {
      const element = document.querySelector('.danmaku-message')
      if (!element) throw new Error('弹幕元素不存在')
      const style = getComputedStyle(element)
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        color: style.color,
        backgroundColor: style.backgroundColor
      }
    })()`,
    true
  ) as Promise<AutomatedComputedStyle>
}

function automatedStyleMatches(style: AutomatedComputedStyle): boolean {
  return (
    style.fontSize === '31px' &&
    style.fontWeight === '600' &&
    style.color === 'rgb(167, 228, 107)' &&
    style.backgroundColor === 'rgba(16, 21, 18, 0.42)'
  )
}

async function verifyControlMenuHiddenAfterAlt(): Promise<boolean> {
  const window = controlWindow
  if (!window || window.isDestroyed()) return false
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  return !window.isMenuBarVisible()
}

async function verifyEventManagementControls(): Promise<EventManagementSmokeResult> {
  const window = controlWindow
  if (!window || window.isDestroyed()) {
    return {
      filterVerified: false,
      copyVerified: false,
      removeVerified: false,
      filteredClearVerified: false
    }
  }

  const result = (await window.webContents.executeJavaScript(
    `(async () => {
      const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 40))
      const rows = () => Array.from(document.querySelectorAll('[data-testid="event-row"]'))
      const danmakuFilter = document.querySelector('[data-testid="event-filter-danmaku"]')
      if (!(danmakuFilter instanceof HTMLButtonElement)) throw new Error('弹幕筛选按钮不存在')
      danmakuFilter.click()
      await waitForRender()

      const filteredRows = rows()
      const filterVerified =
        filteredRows.length > 0 &&
        filteredRows.every((row) => row.getAttribute('data-event-type') === 'danmaku.created')
      const firstRow = filteredRows[0]
      const summary = firstRow?.querySelector('[data-testid="event-summary"]')?.textContent?.trim() ?? ''
      const copyButton = firstRow?.querySelector('[data-testid="event-copy"]')
      if (!(copyButton instanceof HTMLButtonElement)) throw new Error('事件复制按钮不存在')
      copyButton.click()
      await waitForRender()

      const removedEventId = rows()[0]?.getAttribute('data-event-id') ?? ''
      const removeButton = rows()[0]?.querySelector('[data-testid="event-remove"]')
      if (!(removeButton instanceof HTMLButtonElement)) throw new Error('事件移除按钮不存在')
      removeButton.click()
      await waitForRender()
      const removeVerified =
        removedEventId.length > 0 &&
        rows().every((row) => row.getAttribute('data-event-id') !== removedEventId)

      const clearButton = document.querySelector('[data-testid="event-clear"]')
      if (!(clearButton instanceof HTMLButtonElement)) throw new Error('事件清空按钮不存在')
      if (!clearButton.disabled) clearButton.click()
      await waitForRender()
      const danmakuCleared = rows().length === 0

      const allFilter = document.querySelector('[data-testid="event-filter-all"]')
      if (!(allFilter instanceof HTMLButtonElement)) throw new Error('全部筛选按钮不存在')
      allFilter.click()
      await waitForRender()
      const remainingRows = rows()
      return {
        filterVerified,
        expectedClipboard: summary,
        removeVerified,
        filteredClearVerified:
          danmakuCleared &&
          remainingRows.length > 0 &&
          remainingRows.every((row) => row.getAttribute('data-event-type') !== 'danmaku.created')
      }
    })()`,
    true
  )) as {
    filterVerified: boolean
    expectedClipboard: string
    removeVerified: boolean
    filteredClearVerified: boolean
  }

  return {
    filterVerified: result.filterVerified,
    copyVerified: result.expectedClipboard.length > 0 && clipboard.readText() === result.expectedClipboard,
    removeVerified: result.removeVerified,
    filteredClearVerified: result.filteredClearVerified
  }
}

async function restartAutomatedDemo(): Promise<void> {
  const oldOverlay = overlayWindow
  if (!oldOverlay || oldOverlay.isDestroyed()) throw new Error('首次覆盖层不存在')
  automatedFirstOverlayId = oldOverlay.id
  await new Promise((resolve) => setTimeout(resolve, 150))
  automatedOldMessageCount = await countOverlayMessages(oldOverlay)
  await saveOverlayStyle({
    ...overlayStyle,
    fontFamily: 'mono',
    fontSizePx: 31,
    fontWeight: 600,
    textColor: '#A7E46B',
    backgroundOpacity: 0.42
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  automatedLiveStyleApplied = automatedStyleMatches(await readAutomatedComputedStyle(oldOverlay))

  await stopActiveSession(false)
  automatedOldOverlayDestroyed = oldOverlay.isDestroyed()
  if (!fixtureWindow || fixtureWindow.isDestroyed()) throw new Error('测试画面已意外关闭')

  const sourceId = fixtureWindow.getMediaSourceId()
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 320, height: 180 }
  })
  const source = sources.find((candidate) => candidate.id === sourceId)
  if (!source) throw new Error('重启时无法找到内置测试画面')

  automatedStage = 'second'
  await startSource(
    { id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() },
    fixtureWindow.getBounds(),
    true
  )
}

const state: AppState = {
  backend: 'starting',
  connection: 'disconnected',
  session: 'idle',
  framesAccepted: 0,
  framesDropped: 0
}

function rendererUrl(page: string): string {
  const root = process.env.ELECTRON_RENDERER_URL
  if (!root) throw new Error('开发服务器地址不存在')
  return new URL(page, root.endsWith('/') ? root : `${root}/`).toString()
}

async function loadPage(window: BrowserWindow, page: string): Promise<void> {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(rendererUrl(page))
  } else {
    await window.loadFile(join(__dirname, '../renderer', page))
  }
}

function webPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

function broadcastState(): void {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('damu:state', { ...state })
  }
}

function broadcastOverlayStyle(): void {
  for (const window of [controlWindow, overlayWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('damu:overlay-style', { ...overlayStyle })
    }
  }
}

async function saveOverlayStyle(value: unknown): Promise<OverlayStyleSettings> {
  if (!overlayStyleStore) throw new Error('弹幕样式存储尚未就绪')
  overlayStyle = await overlayStyleStore.save(value)
  broadcastOverlayStyle()
  return { ...overlayStyle }
}

function broadcastEvent(envelope: EventEnvelope): void {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('damu:event', envelope)
  }
  if (
    overlayWindow &&
    !overlayWindow.isDestroyed() &&
    shouldForwardEventToOverlay(envelope, captureRuntime?.sessionId)
  ) {
    overlayWindow.webContents.send('damu:event', envelope)
  }
}

function resetOverlayMessages(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('damu:overlay-reset')
  }
}

function destroyOverlayWindow(): void {
  const window = overlayWindow
  overlayWindow = null
  lastOverlayBounds = undefined
  disposeOverlayWindow(window)
}

async function createControlWindow(): Promise<void> {
  controlWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#101512',
    title: 'DaMu Control',
    show: false,
    webPreferences: webPreferences()
  })
  controlWindow.once('ready-to-show', () => controlWindow?.show())
  controlWindow.on('closed', () => {
    controlWindow = null
  })
  await loadPage(controlWindow, 'index.html')
}

async function ensureOverlay(bounds?: Electron.Rectangle): Promise<void> {
  let zOrderRestored = false
  let created = false
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    const workArea = screen.getPrimaryDisplay().workArea
    const window = new BrowserWindow({
      ...(bounds ?? workArea),
      transparent: true,
      frame: false,
      show: false,
      opacity: 0,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      title: 'DaMu Overlay',
      webPreferences: webPreferences()
    })
    overlayWindow = window
    created = true
    window.setIgnoreMouseEvents(true, { forward: true })
    window.setContentProtection(true)
    await loadPage(window, 'overlay.html')
    if (window.isDestroyed() || overlayWindow !== window) return
    lastOverlayBounds = { ...(bounds ?? workArea) }
  } else if (bounds) {
    zOrderRestored = applyOverlayBounds(bounds)
  }
  if (!created && !zOrderRestored) restoreOverlayZOrder(overlayWindow)
}

function applyOverlayBounds(bounds: WindowBoundsLike): boolean {
  if (!overlayWindow || overlayWindow.isDestroyed() || boundsEqual(lastOverlayBounds, bounds)) {
    return false
  }
  overlayWindow.setBounds(bounds)
  lastOverlayBounds = { ...bounds }
  restoreOverlayZOrder(overlayWindow)
  broadcastEvent({
    schema_version: '1',
    event_id: randomUUID(),
    type: 'window.bounds_changed',
    session_id: state.sessionId,
    emitted_at: new Date().toISOString(),
    payload: { ...bounds }
  })
  return true
}

function stopWindowTracking(): void {
  windowBoundsGeneration += 1
  if (windowBoundsTimer) clearInterval(windowBoundsTimer)
  windowBoundsTimer = null
  windowBoundsRequestPending = false
  lastOverlayBounds = undefined
}

async function readWindowBounds(hwnd: number): Promise<Electron.Rectangle> {
  return backend.request<Electron.Rectangle>(`/api/v1/windows/${hwnd}/bounds`)
}

function startWindowTracking(hwnd: number): void {
  if (windowBoundsTimer) clearInterval(windowBoundsTimer)
  const generation = ++windowBoundsGeneration
  windowBoundsTimer = setInterval(() => {
    if (windowBoundsRequestPending || !captureRuntime) return
    windowBoundsRequestPending = true
    void readWindowBounds(hwnd)
      .then((bounds) => {
        if (generation === windowBoundsGeneration && captureRuntime) applyOverlayBounds(bounds)
      })
      .catch(() => {
        // Minimized and short-lived unavailable states are retried on the next tick.
      })
      .finally(() => {
        if (generation === windowBoundsGeneration) windowBoundsRequestPending = false
      })
  }, 250)
}

async function listSources(): Promise<CaptureSourceInfo[]> {
  const ownIds = new Set(
    [controlWindow, overlayWindow, captureWindow, fixtureWindow]
      .filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()))
      .map((window) => window.getMediaSourceId())
  )
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false
  })
  return sources
    .filter((source) => !ownIds.has(source.id) || source.id === fixtureWindow?.getMediaSourceId())
    .map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL()
    }))
}

function parseHwnd(sourceId: string): number | undefined {
  const match = /^window:(\d+):/.exec(sourceId)
  return match ? Number.parseInt(match[1], 10) : undefined
}

async function stopActiveSession(closeFixture = true): Promise<void> {
  stopWindowTracking()
  captureWindow?.destroy()
  captureWindow = null
  const sessionId = captureRuntime?.sessionId
  captureRuntime = null
  approvedSourceId = null
  resetOverlayMessages()
  destroyOverlayWindow()
  if (sessionId) {
    state.session = 'stopping'
    broadcastState()
    try {
      await backend.request(`/api/v1/sessions/${sessionId}`, { method: 'DELETE' })
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    }
  }
  if (closeFixture) {
    if (fixtureWindow && !fixtureWindow.isDestroyed()) fixtureWindow.close()
    fixtureWindow = null
  }
  state.session = 'idle'
  state.sessionId = undefined
  state.activeWindow = undefined
  broadcastState()
}

async function startSource(
  source: CaptureSourceInfo,
  bounds?: Electron.Rectangle,
  preserveFixture = false
): Promise<void> {
  await backend.start()
  if (captureRuntime) await stopActiveSession(!preserveFixture)
  else destroyOverlayWindow()
  state.session = 'starting'
  state.error = undefined
  state.framesAccepted = 0
  state.framesDropped = 0
  broadcastState()

  const hwnd = parseHwnd(source.id)
  const overlayBounds = bounds ?? (hwnd ? await readWindowBounds(hwnd) : undefined)
  if (!overlayBounds) throw new Error('无法读取目标窗口的位置和尺寸')

  const profile = await backend.request<ProfileResponse>('/api/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ name: source.name, window_title_pattern: source.name })
  })
  const created = await backend.request<SessionResponse>('/api/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({
      profile_id: profile.id,
      source_id: source.id,
      hwnd,
      window_name: source.name
    })
  })
  approvedSourceId = source.id
  captureRuntime = { sessionId: created.id, regionId: profile.regions[0].id }
  state.sessionId = created.id
  state.activeWindow = source.name
  resetOverlayMessages()
  await ensureOverlay(overlayBounds)
  if (hwnd) startWindowTracking(hwnd)

  captureWindow = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    title: 'DaMu Capture',
    webPreferences: { ...webPreferences(), backgroundThrottling: false }
  })
  captureWindow.on('closed', () => {
    captureWindow = null
  })
  await loadPage(captureWindow, 'capture.html')
}

async function startDemo(): Promise<void> {
  if (fixtureWindow && !fixtureWindow.isDestroyed()) fixtureWindow.destroy()
  fixtureWindow = new BrowserWindow({
    width: 820,
    height: 500,
    minWidth: 700,
    minHeight: 420,
    backgroundColor: '#172019',
    title: 'DaMu Test Scene',
    show: false,
    webPreferences: webPreferences()
  })
  await loadPage(fixtureWindow, 'fixture.html')
  fixtureWindow.show()
  const sourceId = fixtureWindow.getMediaSourceId()
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 320, height: 180 }
  })
  const source = sources.find((candidate) => candidate.id === sourceId)
  if (!source) throw new Error('无法找到内置测试画面的捕获源')
  await startSource(
    { id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() },
    fixtureWindow.getBounds(),
    true
  )
}

function setupIpc(): void {
  ipcMain.handle('damu:get-state', () => ({ ...state }))
  ipcMain.handle('damu:get-overlay-style', () => ({ ...overlayStyle }))
  ipcMain.handle('damu:update-overlay-style', (_event, value: unknown) => saveOverlayStyle(value))
  ipcMain.on('damu:overlay-style-ready', (event) => {
    const window = overlayWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return
    window.setOpacity(1)
    restoreOverlayZOrder(window)
  })
  ipcMain.handle('damu:list-sources', () => listSources())
  ipcMain.handle('damu:start-demo', () => startDemo())
  ipcMain.handle('damu:start-source', async (_event, sourceId: string) => {
    assertSourceId(sourceId)
    const sources = await listSources()
    const source = sources.find((candidate) => candidate.id === sourceId)
    if (!source) throw new Error('选择的窗口已经不可用，请刷新窗口列表')
    await startSource(source)
  })
  ipcMain.handle('damu:stop-session', () => stopActiveSession())
  ipcMain.handle('damu:copy-text', (_event, text: unknown) => {
    assertClipboardText(text)
    clipboard.writeText(text)
  })
  ipcMain.handle('damu:get-capture-runtime', () => captureRuntime)
  ipcMain.handle('damu:upload-frame', async (_event, payload: FrameUpload) => {
    assertFrameUpload(payload)
    if (!captureRuntime || payload.sessionId !== captureRuntime.sessionId) {
      throw new Error('采集会话已经失效')
    }
    if (!backend.connected) throw new Error('WebSocket 未连接，已暂停上传')
    if (payload.bytes.byteLength > 1024 * 1024) throw new Error('JPEG 超过 1 MiB')
    const receipt = await backend.uploadFrame(payload)
    if (receipt.accepted) state.framesAccepted += 1
    if (receipt.dropped_frame_id || !receipt.accepted) state.framesDropped += 1
    broadcastState()
    return receipt
  })
  ipcMain.handle('damu:overlay-test', async () => {
    await ensureOverlay()
    broadcastEvent({
      schema_version: '1',
      event_id: randomUUID(),
      type: 'danmaku.created',
      emitted_at: new Date().toISOString(),
      payload: {
        message_id: randomUUID(),
        text: '覆盖层自检通过',
        style: { tone: 'signal' },
        duration_ms: 5200
      }
    })
  })
}

function setupBackendEvents(): void {
  backend.on('connection', (connected: boolean) => {
    state.connection = connected ? 'connected' : 'disconnected'
    state.backend = connected ? 'online' : state.backend
    broadcastState()
  })
  backend.on('event', (envelope: EventEnvelope) => {
    state.lastEvent = envelope.type
    if (envelope.type === 'session.status') {
      state.session = envelope.payload.status === 'running' ? 'running' : 'idle'
    }
    if (envelope.type === 'error') {
      state.error = String(envelope.payload.message ?? '后端事件错误')
      state.session = 'error'
    }
    broadcastState()
    broadcastEvent(envelope)
    if (automatedDemo && envelope.type === 'danmaku.created' && automatedStage === 'first') {
      automatedStage = 'restarting'
      void restartAutomatedDemo().catch((error: unknown) => {
        finishAutomatedDemo('error', {
          message: error instanceof Error ? error.message : String(error),
          restart_verified: false
        })
      })
    } else if (
      automatedDemo &&
      envelope.type === 'danmaku.created' &&
      automatedStage === 'second'
    ) {
      automatedStage = 'restarting'
      const newOverlay = overlayWindow
      setTimeout(() => {
        void (async () => {
          const newMessageCount = newOverlay ? await countOverlayMessages(newOverlay) : 0
          const restartedStyle = newOverlay ? await readAutomatedComputedStyle(newOverlay) : undefined
          const overlayReady = Boolean(
            newOverlay &&
              !newOverlay.isDestroyed() &&
              newOverlay.isVisible() &&
              newOverlay.isAlwaysOnTop() &&
              !newOverlay.isFocusable()
          )
          const overlayRecreated = Boolean(
            newOverlay &&
              automatedFirstOverlayId !== undefined &&
              newOverlay.id !== automatedFirstOverlayId &&
              automatedOldOverlayDestroyed
          )
          const controlMenuHiddenAfterAlt = await verifyControlMenuHiddenAfterAlt()
          const eventManagement = await verifyEventManagementControls()
          const restartVerified =
            overlayReady &&
            overlayRecreated &&
            automatedOldMessageCount >= 1 &&
            newMessageCount >= 1 &&
            automatedLiveStyleApplied &&
            Boolean(restartedStyle && automatedStyleMatches(restartedStyle)) &&
            eventManagement.filterVerified &&
            eventManagement.copyVerified &&
            eventManagement.removeVerified &&
            eventManagement.filteredClearVerified
          finishAutomatedDemo(restartVerified ? 'ok' : 'error', {
            event_id: envelope.event_id,
            session_id: envelope.session_id,
            frames_accepted: state.framesAccepted,
            overlay_visible: newOverlay?.isVisible() ?? false,
            overlay_always_on_top: newOverlay?.isAlwaysOnTop() ?? false,
            overlay_focusable: newOverlay?.isFocusable() ?? true,
            overlay_recreated: overlayRecreated,
            old_overlay_destroyed: automatedOldOverlayDestroyed,
            old_message_count: automatedOldMessageCount,
            new_message_count: newMessageCount,
            live_style_applied: automatedLiveStyleApplied,
            restarted_style_applied: Boolean(restartedStyle && automatedStyleMatches(restartedStyle)),
            computed_style: restartedStyle,
            application_menu_removed: Menu.getApplicationMenu() === null,
            control_menu_hidden: !(controlWindow?.isMenuBarVisible() ?? true),
            control_menu_hidden_after_alt: controlMenuHiddenAfterAlt,
            event_filter_verified: eventManagement.filterVerified,
            event_copy_verified: eventManagement.copyVerified,
            event_remove_verified: eventManagement.removeVerified,
            event_filtered_clear_verified: eventManagement.filteredClearVerified,
            restart_verified: restartVerified
          })
        })().catch((error: unknown) => {
          finishAutomatedDemo('error', {
            message: error instanceof Error ? error.message : String(error),
            restart_verified: false
          })
        })
      }, 150)
    }
  })
  backend.on(
    'exit',
    ({ unexpected }: { unexpected: boolean; code: number | null; signal: NodeJS.Signals | null }) => {
      state.backend = unexpected ? 'error' : 'offline'
      state.connection = 'disconnected'
      if (unexpected) state.error = 'Python 后端意外退出'
      broadcastState()
      if (unexpected && !backendRestarted && !shutdownStarted) {
        backendRestarted = true
        setTimeout(() => {
          state.backend = 'starting'
          broadcastState()
          void backend.start().catch((error: unknown) => {
            state.backend = 'error'
            state.error = error instanceof Error ? error.message : String(error)
            broadcastState()
          })
        }, 500)
      }
    }
  )
}

async function cleanup(): Promise<void> {
  try {
    await stopActiveSession()
  } catch {
    // Continue shutting down even when the active session cannot be closed.
  }
  await backend.stop()
}

const hasLock = automatedDemo || app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    overlayStyleStore = new OverlayStyleStore(
      join(app.getPath('userData'), 'overlay-style.json'),
      (message) => console.warn(message)
    )
    overlayStyle = await overlayStyleStore.load()
    setupIpc()
    setupBackendEvents()
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media')
    })
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources: DesktopCapturerSource[] = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 }
      })
      const selected = sources.find((source) => source.id === approvedSourceId)
      callback(selected ? { video: selected } : {})
    })
    await createControlWindow()
    state.backend = 'starting'
    broadcastState()
    try {
      await backend.start()
      if (automatedDemo) await startDemo()
    } catch (error) {
      state.backend = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      broadcastState()
      if (automatedDemo) finishAutomatedDemo('error', { message: state.error })
    }
  })

  app.on('second-instance', () => {
    if (controlWindow) {
      if (controlWindow.isMinimized()) controlWindow.restore()
      controlWindow.focus()
    }
  })

  app.on('before-quit', (event) => {
    if (shutdownStarted) return
    shutdownStarted = true
    event.preventDefault()
    void cleanup().finally(() => app.quit())
  })
}
