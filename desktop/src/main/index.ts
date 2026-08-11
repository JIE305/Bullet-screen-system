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
  safeStorage,
  screen,
  session,
  type DesktopCapturerSource
} from 'electron'
import { BackendClient } from './backend-client'
import { OverlayStyleStore } from './overlay-style-store'
import { CloudApiStore } from './cloud-api-store'
import type {
  AppState,
  CaptureRuntime,
  CaptureSourceInfo,
  EventEnvelope,
  FrameReceipt,
  FrameUpload
} from '../shared/contracts'
import { assertClipboardText, assertFrameUpload, assertSourceId } from '../shared/ipc-validation'
import {
  DEFAULT_ROI,
  DEFAULT_RULE,
  parseCaptureStartOptions,
  parseGlobalRules,
  type CaptureStartOptions
} from '../shared/capture-settings'
import { shouldForwardEventToOverlay } from '../shared/overlay-events'
import { disposeOverlayWindow } from '../shared/overlay-lifecycle'
import {
  cloneDefaultOverlayStyle,
  type OverlayStyleSettings
} from '../shared/overlay-style'
import { restoreOverlayZOrder } from '../shared/overlay-z-order'
import {
  boundsEqual,
  isWindowUnavailableError,
  type WindowBoundsLike
} from '../shared/window-bounds'
import type { CloudApiRuntimeState, CloudApiTestResult } from '../shared/cloud-api'

interface ProfileResponse {
  id: string
  name: string
  window_title_pattern?: string
  regions: Array<{
    id: string
    x: number
    y: number
    width: number
    height: number
    preprocess_mode: 'original' | 'high_contrast'
  }>
  rules: Array<{
    id: string
    match_type: 'contains' | 'exact'
    pattern: string
    template: string
    confidence: number
    cooldown_ms: number
    enabled: boolean
  }>
}

interface BackendRule {
  id: string
  match_type: 'contains' | 'exact'
  pattern: string
  template: string
  confidence: number
  cooldown_ms: number
  enabled: boolean
}

interface SessionResponse {
  id: string
}

interface BackendGenerationTestResult {
  text: string
  elapsed_ms: number
  model: string
  provider_request_id?: string
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
let cloudApiStore: CloudApiStore | null = null
let cloudApiState: CloudApiRuntimeState = { status: 'unconfigured' }
const automatedDemo = process.env.DAMU_AUTOMATED_DEMO === '1'
const automatedResultPath = process.env.DAMU_AUTOMATED_RESULT
let automatedStage: 'first' | 'restarting' | 'second' | 'finished' = 'first'
let automatedFirstOverlayId: number | undefined
let automatedOldOverlayDestroyed = false
let automatedOldMessageCount = 0
let automatedLiveStyleApplied = false
let automatedExistingSpeedPreserved = false

interface AutomatedComputedStyle {
  fontSize: string
  fontWeight: string
  color: string
  backgroundColor: string
  animationDuration: string
}

interface EventManagementSmokeResult {
  filterVerified: boolean
  copyVerified: boolean
  removeVerified: boolean
  filteredClearVerified: boolean
}

interface StyleDrawerSpeedSmokeResult {
  scaleAligned: boolean
  previewSpeedUpdated: boolean
  previewRestarted: boolean
}

interface DanmakuContentSmokeResult {
  matches: boolean
  overlayText: string
  eventText: string
}

interface CloudUiSmokeResult {
  railFits: boolean
  noHorizontalOverflow: boolean
  drawerScrollable: boolean
  drawerBottomReachable: boolean
  keyHiddenFromRenderer: boolean
  escapeAndFocusReturn: boolean
  backdropBlurOnly: boolean
  railScrollHeight?: number
  railClientHeight?: number
  cardBottom?: number
  viewportHeight?: number
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
        backgroundColor: style.backgroundColor,
        animationDuration: style.animationDuration
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

async function verifyBackendCrashRecovery(): Promise<boolean> {
  backend.crashForTest()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (backendRestarted && state.backend === 'online' && state.connection === 'connected') {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
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

async function verifyStyleDrawerSpeed(): Promise<StyleDrawerSpeedSmokeResult> {
  const window = controlWindow
  if (!window || window.isDestroyed()) {
    return { scaleAligned: false, previewSpeedUpdated: false, previewRestarted: false }
  }

  return window.webContents.executeJavaScript(
    `(async () => {
      const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 60))
      const trigger = document.querySelector('[data-testid="style-trigger"]')
      if (!(trigger instanceof HTMLButtonElement)) throw new Error('弹幕样式按钮不存在')
      trigger.click()
      await waitForRender()

      const input = document.querySelector('[data-testid="overlay-speed-input"]')
      const firstPreview = document.querySelector('[data-testid="style-preview-message"]')
      if (!(input instanceof HTMLInputElement) || !(firstPreview instanceof HTMLElement)) {
        throw new Error('弹幕速度控件或预览不存在')
      }

      const applySpeed = async (value) => {
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await waitForRender()
        const preview = document.querySelector('[data-testid="style-preview-message"]')
        if (!(preview instanceof HTMLElement)) throw new Error('弹幕速度预览更新失败')
        return { preview, duration: getComputedStyle(preview).animationDuration }
      }

      const slow = await applySpeed('0.5')
      const fast = await applySpeed('2.0')
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
      const labels = Array.from(document.querySelectorAll('.speed-scale span'))
      const scale = document.querySelector('.speed-scale')
      const sliderRect = input.getBoundingClientRect()
      const scaleRect = scale?.getBoundingClientRect()
      const scaleAligned =
        labels.length === 3 &&
        scaleRect !== undefined &&
        Math.abs(scaleRect.left - sliderRect.left) < 1 &&
        Math.abs(scaleRect.right - sliderRect.right) < 1 &&
        getComputedStyle(labels[0]).textAlign === 'left' &&
        getComputedStyle(labels[1]).textAlign === 'center' &&
        getComputedStyle(labels[2]).textAlign === 'right'
      const close = document.querySelector('.drawer-close')
      if (close instanceof HTMLButtonElement) close.click()

      return {
        scaleAligned,
        previewSpeedUpdated: reducedMotion
          ? slow.duration === '5.2s' && fast.duration === '5.2s'
          : slow.duration === '14s' && fast.duration === '3.5s',
        previewRestarted: firstPreview !== slow.preview && slow.preview !== fast.preview
      }
    })()`,
    true
  ) as Promise<StyleDrawerSpeedSmokeResult>
}

async function verifyCloudApiUi(): Promise<CloudUiSmokeResult> {
  const window = controlWindow
  if (!window || window.isDestroyed()) {
    return {
      railFits: false,
      noHorizontalOverflow: false,
      drawerScrollable: false,
      drawerBottomReachable: false,
      keyHiddenFromRenderer: false,
      escapeAndFocusReturn: false,
      backdropBlurOnly: false
    }
  }
  window.setSize(1100, 720)
  await new Promise((resolve) => setTimeout(resolve, 80))
  return window.webContents.executeJavaScript(
    `(async () => {
      const wait = () => new Promise((resolve) => setTimeout(resolve, 70))
      const rail = document.querySelector('.rail')
      const card = document.querySelector('.cloud-card')
      const trigger = document.querySelector('[data-testid="cloud-config-trigger"]')
      if (!(rail instanceof HTMLElement) || !(card instanceof HTMLElement) || !(trigger instanceof HTMLButtonElement)) {
        throw new Error('云端状态卡或配置入口不存在')
      }
      const cardRect = card.getBoundingClientRect()
      const railFits = rail.scrollHeight <= rail.clientHeight && cardRect.bottom <= innerHeight
      const noHorizontalOverflow = document.documentElement.scrollWidth <= document.documentElement.clientWidth
      trigger.click()
      await wait()
      const drawer = document.querySelector('[data-testid="cloud-api-drawer"]')
      if (!(drawer instanceof HTMLElement)) throw new Error('云端配置抽屉不存在')
      const backdrop = document.querySelector('.cloud-backdrop')
      if (!(backdrop instanceof HTMLElement)) throw new Error('云端配置背景遮罩不存在')
      const backdropStyle = getComputedStyle(backdrop)
      const backdropBlurOnly =
        backdropStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        (backdropStyle.backdropFilter.includes('blur') || backdropStyle.webkitBackdropFilter?.includes('blur'))
      const before = drawer.scrollTop
      drawer.scrollTop = drawer.scrollHeight
      await wait()
      const footer = drawer.querySelector('footer')
      const drawerBottomReachable =
        footer instanceof HTMLElement && footer.getBoundingClientRect().bottom <= innerHeight + 1
      const drawerScrollable = drawer.scrollHeight > drawer.clientHeight && drawer.scrollTop > before
      const publicSettings = await window.damu.getCloudApiSettings()
      const keyInput = drawer.querySelector('input[type="password"]')
      const keyHiddenFromRenderer =
        !Object.prototype.hasOwnProperty.call(publicSettings, 'apiKey') && keyInput instanceof HTMLInputElement
      drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 500))
      return {
        railFits,
        noHorizontalOverflow,
        drawerScrollable,
        drawerBottomReachable,
        keyHiddenFromRenderer,
        backdropBlurOnly,
        escapeAndFocusReturn:
          !document.querySelector('[data-testid="cloud-api-drawer"]') && document.activeElement === trigger,
        railScrollHeight: rail.scrollHeight,
        railClientHeight: rail.clientHeight,
        cardBottom: cardRect.bottom,
        viewportHeight: innerHeight
      }
    })()`,
    true
  ) as Promise<CloudUiSmokeResult>
}

async function verifyDanmakuContentParity(
  window: BrowserWindow | null
): Promise<DanmakuContentSmokeResult> {
  if (!window || window.isDestroyed() || !controlWindow || controlWindow.isDestroyed()) {
    return { matches: false, overlayText: '', eventText: '' }
  }
  const overlayText = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.danmaku-message')).at(-1)?.textContent?.trim() ?? ''`,
    true
  )) as string
  const eventText = (await controlWindow.webContents.executeJavaScript(
    `document.querySelector('[data-event-type="danmaku.created"] [data-testid="event-summary"]')?.textContent?.trim() ?? ''`,
    true
  )) as string
  return {
    matches: overlayText.length > 0 && overlayText === eventText,
    overlayText,
    eventText
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
    backgroundOpacity: 0.42,
    speedMultiplier: 2
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const liveStyle = await readAutomatedComputedStyle(oldOverlay)
  automatedLiveStyleApplied = automatedStyleMatches(liveStyle)
  automatedExistingSpeedPreserved = liveStyle.animationDuration === '7.2s'

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
    true,
    { region: DEFAULT_ROI, preprocessMode: 'original' },
    'profile'
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

function broadcastCloudApiState(): void {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('damu:cloud-api-state', { ...cloudApiState })
  }
}

function idleCloudApiState(): CloudApiRuntimeState {
  const settings = cloudApiStore?.getPublic()
  if (!settings?.hasApiKey || !settings.baseUrl || !settings.model) {
    return { status: 'unconfigured', model: settings?.model }
  }
  return { status: settings.enabled ? 'ready' : 'disabled', model: settings.model }
}

async function syncCloudApiSettings(): Promise<void> {
  if (!cloudApiStore) throw new Error('云端 API 配置存储尚未就绪')
  await backend.request('/api/v1/generation/config', {
    method: 'PUT',
    body: JSON.stringify(cloudApiStore.getSecretConfig())
  })
  cloudApiState = idleCloudApiState()
  broadcastCloudApiState()
}

async function saveCloudApiSettings(value: unknown): Promise<ReturnType<CloudApiStore['getPublic']>> {
  if (!cloudApiStore) throw new Error('云端 API 配置存储尚未就绪')
  if (captureRuntime || state.session !== 'idle') {
    throw new Error('请先停止当前会话，再修改云端 API 配置')
  }
  const saved = await cloudApiStore.save(value)
  try {
    await backend.start()
    await syncCloudApiSettings()
  } catch (error) {
    cloudApiState = {
      status: 'error',
      model: saved.model,
      error: `配置已保存，但同步本地后端失败：${error instanceof Error ? error.message : String(error)}`
    }
    broadcastCloudApiState()
    throw error
  }
  return saved
}

async function testCloudApi(): Promise<CloudApiTestResult> {
  if (!cloudApiStore) throw new Error('云端 API 配置存储尚未就绪')
  if (captureRuntime || state.session !== 'idle') throw new Error('请先停止当前会话，再测试云端 API')
  await backend.start()
  await syncCloudApiSettings()
  cloudApiState = { status: 'calling', model: cloudApiStore.getPublic().model }
  broadcastCloudApiState()
  try {
    const result = await backend.request<BackendGenerationTestResult>('/api/v1/generation/test', {
      method: 'POST',
      body: JSON.stringify({ text: '胜利', local_text: '胜利' })
    })
    const mapped: CloudApiTestResult = {
      text: result.text,
      elapsedMs: result.elapsed_ms,
      model: result.model,
      ...(result.provider_request_id ? { providerRequestId: result.provider_request_id } : {})
    }
    cloudApiState = {
      ...idleCloudApiState(),
      model: result.model,
      lastLatencyMs: result.elapsed_ms,
      lastResult: result.text
    }
    broadcastCloudApiState()
    return mapped
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    cloudApiState = {
      status: message.includes('rate_limited') || message.startsWith('429') ? 'rate_limited' : 'error',
      model: cloudApiStore.getPublic().model,
      error: message
    }
    broadcastCloudApiState()
    throw error
  }
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
    // A selected window can reclaim the foreground without changing its bounds.
    // Reassert the overlay Z-order immediately before displaying real danmaku so
    // an event that reached the control log cannot remain hidden behind the target.
    if (envelope.type === 'danmaku.created') {
      restoreOverlayZOrder(overlayWindow)
    }
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
  if (!overlayWindow || overlayWindow.isDestroyed()) return false

  const boundsChanged = !boundsEqual(lastOverlayBounds, bounds)
  if (boundsChanged) {
    overlayWindow.setBounds(bounds)
    lastOverlayBounds = { ...bounds }
  }

  // Window activation can drop the overlay out of the topmost band even when
  // position and size stay unchanged. The tracking poll must repair that state.
  const shouldRestoreZOrder = boundsChanged || !overlayWindow.isAlwaysOnTop()
  if (shouldRestoreZOrder) restoreOverlayZOrder(overlayWindow)

  if (boundsChanged) {
    broadcastEvent({
      schema_version: '1',
      event_id: randomUUID(),
      type: 'window.bounds_changed',
      session_id: state.sessionId,
      emitted_at: new Date().toISOString(),
      payload: { ...bounds }
    })
  }
  return shouldRestoreZOrder
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
  let consecutiveFailures = 0
  windowBoundsTimer = setInterval(() => {
    if (windowBoundsRequestPending || !captureRuntime) return
    windowBoundsRequestPending = true
    void readWindowBounds(hwnd)
      .then((bounds) => {
        consecutiveFailures = 0
        if (generation === windowBoundsGeneration && captureRuntime) applyOverlayBounds(bounds)
      })
      .catch((error: unknown) => {
        const targetUnavailable = isWindowUnavailableError(error)
        if (!targetUnavailable) {
          consecutiveFailures = 0
          return
        }
        consecutiveFailures += 1
        if (generation !== windowBoundsGeneration || consecutiveFailures < 8) return
        state.error = '目标窗口已关闭或长时间不可用，会话已安全停止'
        void stopActiveSession(false, 'window_unavailable')
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

async function stopActiveSession(
  closeFixture = true,
  reason: 'user_requested' | 'window_unavailable' = 'user_requested'
): Promise<void> {
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
      await backend.request(`/api/v1/sessions/${sessionId}?reason=${reason}`, { method: 'DELETE' })
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
  preserveFixture = false,
  settings: Omit<CaptureStartOptions, 'sourceId'> = {
    region: DEFAULT_ROI,
    preprocessMode: 'original'
  },
  ruleScope: 'global' | 'profile' = 'global'
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

  const profileBody: Record<string, unknown> = {
      name: source.name,
      window_title_pattern: source.name,
      regions: [
        {
          name: '主要文字区域',
          ...settings.region,
          preprocess_mode: settings.preprocessMode,
          enabled: true
        }
      ]
  }
  if (ruleScope === 'profile') {
    profileBody.rules = [
      {
        match_type: DEFAULT_RULE.matchType,
        pattern: DEFAULT_RULE.pattern,
        template: DEFAULT_RULE.template,
        confidence: DEFAULT_RULE.confidence,
        cooldown_ms: DEFAULT_RULE.cooldownMs,
        enabled: true
      }
    ]
  }
  const profiles = await backend.request<ProfileResponse[]>('/api/v1/profiles')
  const existing = profiles.find((item) => item.window_title_pattern === source.name)
  const profile = await backend.request<ProfileResponse>(
    existing ? `/api/v1/profiles/${existing.id}` : '/api/v1/profiles',
    {
      method: existing ? 'PATCH' : 'POST',
      body: JSON.stringify(profileBody)
    }
  )
  const created = await backend.request<SessionResponse>('/api/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({
      profile_id: profile.id,
      source_id: source.id,
      hwnd,
      window_name: source.name,
      rule_scope: ruleScope
    })
  })
  approvedSourceId = source.id
  const activeRegion = profile.regions[0]
  captureRuntime = {
    sessionId: created.id,
    regionId: activeRegion.id,
    region: {
      x: activeRegion.x,
      y: activeRegion.y,
      width: activeRegion.width,
      height: activeRegion.height
    },
    preprocessMode: activeRegion.preprocess_mode
  }
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
    true,
    { region: DEFAULT_ROI, preprocessMode: 'original' },
    'profile'
  )
}

function setupIpc(): void {
  ipcMain.handle('damu:get-state', () => ({ ...state }))
  ipcMain.handle('damu:get-overlay-style', () => ({ ...overlayStyle }))
  ipcMain.handle('damu:update-overlay-style', (_event, value: unknown) => saveOverlayStyle(value))
  ipcMain.handle('damu:get-cloud-api-settings', () => {
    if (!cloudApiStore) throw new Error('云端 API 配置存储尚未就绪')
    return cloudApiStore.getPublic()
  })
  ipcMain.handle('damu:save-cloud-api-settings', (_event, value: unknown) =>
    saveCloudApiSettings(value)
  )
  ipcMain.handle('damu:test-cloud-api', () => testCloudApi())
  ipcMain.on('damu:overlay-style-ready', (event) => {
    const window = overlayWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return
    window.setOpacity(1)
    restoreOverlayZOrder(window)
  })
  ipcMain.handle('damu:list-sources', () => listSources())
  ipcMain.handle('damu:get-capture-settings', async (_event, sourceId: unknown) => {
    await backend.start()
    assertSourceId(sourceId)
    const sources = await listSources()
    const source = sources.find((candidate) => candidate.id === sourceId)
    if (!source) return null
    const profiles = await backend.request<ProfileResponse[]>('/api/v1/profiles')
    const profile = profiles.find((item) => item.window_title_pattern === source.name)
    const region = profile?.regions[0]
    if (!region) return null
    return {
      region: { x: region.x, y: region.y, width: region.width, height: region.height },
      preprocessMode: region.preprocess_mode
    }
  })
  ipcMain.handle('damu:get-global-rules', async () => {
    await backend.start()
    const rules = await backend.request<BackendRule[]>('/api/v1/rules/global')
    return rules.map((rule) => ({
      id: rule.id,
      matchType: rule.match_type,
      pattern: rule.pattern,
      template: rule.template,
      confidence: rule.confidence,
      cooldownMs: rule.cooldown_ms,
      enabled: rule.enabled
    }))
  })
  ipcMain.handle('damu:update-global-rules', async (_event, value: unknown) => {
    await backend.start()
    const rules = parseGlobalRules(value)
    const saved = await backend.request<BackendRule[]>('/api/v1/rules/global', {
      method: 'PUT',
      body: JSON.stringify(
        rules.map((rule) => ({
          ...(rule.id ? { id: rule.id } : {}),
          match_type: rule.matchType,
          pattern: rule.pattern,
          template: rule.template,
          confidence: rule.confidence,
          cooldown_ms: rule.cooldownMs,
          enabled: rule.enabled
        }))
      )
    })
    return saved.map((rule) => ({
      id: rule.id,
      matchType: rule.match_type,
      pattern: rule.pattern,
      template: rule.template,
      confidence: rule.confidence,
      cooldownMs: rule.cooldown_ms,
      enabled: rule.enabled
    }))
  })
  ipcMain.handle('damu:start-demo', () => startDemo())
  ipcMain.handle('damu:start-source', async (_event, value: unknown) => {
    const options = parseCaptureStartOptions(value)
    const sourceId = options.sourceId
    assertSourceId(sourceId)
    const sources = await listSources()
    const source = sources.find((candidate) => candidate.id === sourceId)
    if (!source) throw new Error('选择的窗口已经不可用，请刷新窗口列表')
    await startSource(source, undefined, false, {
      region: options.region,
      preprocessMode: options.preprocessMode
    })
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
    if (envelope.type === 'recognition.detected') {
      const evaluation = envelope.payload.rule_evaluation as { status?: unknown } | undefined
      if (evaluation?.status === 'emitted' && cloudApiStore?.getPublic().enabled) {
        cloudApiState = { status: 'calling', model: cloudApiStore.getPublic().model }
        broadcastCloudApiState()
      }
    }
    if (envelope.type === 'danmaku.created') {
      const fallbackReason = typeof envelope.payload.fallback_reason === 'string'
        ? envelope.payload.fallback_reason
        : undefined
      if (envelope.payload.generator === 'cloud') {
        cloudApiState = {
          status: 'ready',
          model: typeof envelope.payload.model === 'string' ? envelope.payload.model : cloudApiStore?.getPublic().model,
          lastLatencyMs: typeof envelope.payload.generation_ms === 'number' ? envelope.payload.generation_ms : undefined
        }
        broadcastCloudApiState()
      } else if (fallbackReason) {
        cloudApiState = {
          status: fallbackReason === 'rate_limited' ? 'rate_limited' : 'error',
          model: cloudApiStore?.getPublic().model,
          error: `云端生成失败，已回退本地模板：${fallbackReason}`
        }
        broadcastCloudApiState()
      }
    }
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
          const danmakuContent = await verifyDanmakuContentParity(newOverlay)
          const controlMenuHiddenAfterAlt = await verifyControlMenuHiddenAfterAlt()
          const eventManagement = await verifyEventManagementControls()
          const styleDrawerSpeed = await verifyStyleDrawerSpeed()
          const cloudUi = await verifyCloudApiUi()
          const backendCrashRecovered = await verifyBackendCrashRecovery()
          const restartVerified =
            overlayReady &&
            overlayRecreated &&
            automatedOldMessageCount >= 1 &&
            newMessageCount >= 1 &&
            automatedLiveStyleApplied &&
            automatedExistingSpeedPreserved &&
            Boolean(restartedStyle && automatedStyleMatches(restartedStyle)) &&
            restartedStyle?.animationDuration === '3.6s' &&
            danmakuContent.matches &&
            styleDrawerSpeed.scaleAligned &&
            styleDrawerSpeed.previewSpeedUpdated &&
            styleDrawerSpeed.previewRestarted &&
            eventManagement.filterVerified &&
            eventManagement.copyVerified &&
            eventManagement.removeVerified &&
            eventManagement.filteredClearVerified &&
            cloudUi.railFits &&
            cloudUi.noHorizontalOverflow &&
            cloudUi.drawerScrollable &&
            cloudUi.drawerBottomReachable &&
            cloudUi.keyHiddenFromRenderer &&
            cloudUi.backdropBlurOnly &&
            cloudUi.escapeAndFocusReturn &&
            backendCrashRecovered
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
            existing_message_speed_preserved: automatedExistingSpeedPreserved,
            restarted_style_applied: Boolean(restartedStyle && automatedStyleMatches(restartedStyle)),
            new_message_speed_applied: restartedStyle?.animationDuration === '3.6s',
            danmaku_content_matches: danmakuContent.matches,
            overlay_danmaku_text: danmakuContent.overlayText,
            event_danmaku_text: danmakuContent.eventText,
            speed_scale_aligned: styleDrawerSpeed.scaleAligned,
            preview_speed_updated: styleDrawerSpeed.previewSpeedUpdated,
            preview_animation_restarted: styleDrawerSpeed.previewRestarted,
            computed_style: restartedStyle,
            application_menu_removed: Menu.getApplicationMenu() === null,
            control_menu_hidden: !(controlWindow?.isMenuBarVisible() ?? true),
            control_menu_hidden_after_alt: controlMenuHiddenAfterAlt,
            event_filter_verified: eventManagement.filterVerified,
            event_copy_verified: eventManagement.copyVerified,
            event_remove_verified: eventManagement.removeVerified,
            event_filtered_clear_verified: eventManagement.filteredClearVerified,
            cloud_rail_fits_1100x720: cloudUi.railFits,
            cloud_no_horizontal_overflow: cloudUi.noHorizontalOverflow,
            cloud_drawer_scrollable: cloudUi.drawerScrollable,
            cloud_drawer_bottom_reachable: cloudUi.drawerBottomReachable,
            cloud_key_hidden_from_renderer: cloudUi.keyHiddenFromRenderer,
            cloud_backdrop_blur_only: cloudUi.backdropBlurOnly,
            cloud_escape_focus_return: cloudUi.escapeAndFocusReturn,
            cloud_rail_scroll_height: cloudUi.railScrollHeight,
            cloud_rail_client_height: cloudUi.railClientHeight,
            cloud_card_bottom: cloudUi.cardBottom,
            cloud_viewport_height: cloudUi.viewportHeight,
            backend_crash_recovered: backendCrashRecovered,
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
          void backend.start().then(() => syncCloudApiSettings()).catch((error: unknown) => {
            state.backend = 'error'
            state.error = error instanceof Error ? error.message : String(error)
            broadcastState()
            cloudApiState = {
              status: 'error',
              model: cloudApiStore?.getPublic().model,
              error: error instanceof Error ? error.message : String(error)
            }
            broadcastCloudApiState()
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
    cloudApiStore = new CloudApiStore(
      join(app.getPath('userData'), 'cloud-api.json'),
      safeStorage,
      (message) => console.warn(message)
    )
    await cloudApiStore.load()
    cloudApiState = idleCloudApiState()
    if (automatedDemo) {
      overlayStyle = await overlayStyleStore.save({ ...overlayStyle, speedMultiplier: 1 })
    }
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
      await syncCloudApiSettings()
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
