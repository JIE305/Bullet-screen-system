import type { CaptureRuntime, DaMuApi } from '../../shared/contracts'

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`缺少采集元素：${selector}`)
  return element
}

const video = requireElement<HTMLVideoElement>('#capture-video')
const canvas = requireElement<HTMLCanvasElement>('#capture-canvas')

function requireApi(): DaMuApi {
  if (!window.damu) throw new Error('采集 preload API 不可用')
  return window.damu
}

const api = requireApi()

let stream: MediaStream | null = null
let stopped = false

function waitForVideo(): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve()
  return new Promise((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }))
}

function canvasBlob(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG 编码失败'))),
      'image/jpeg',
      0.75
    )
  })
}

async function captureOnce(runtime: CaptureRuntime): Promise<void> {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (!sourceWidth || !sourceHeight) return
  const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight))
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('无法创建 Canvas 上下文')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const blob = await canvasBlob()
  if (blob.size > 1024 * 1024) throw new Error('测试帧超过 1 MiB')
  await api.uploadFrame({
    sessionId: runtime.sessionId,
    regionId: runtime.regionId,
    frameId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    width: canvas.width,
    height: canvas.height,
    bytes: await blob.arrayBuffer()
  })
}

async function loop(runtime: CaptureRuntime): Promise<void> {
  while (!stopped) {
    const startedAt = performance.now()
    try {
      await captureOnce(runtime)
    } catch (error) {
      console.error('Capture frame failed', error)
    }
    const delay = Math.max(0, 1000 - (performance.now() - startedAt))
    await new Promise((resolve) => window.setTimeout(resolve, delay))
  }
}

async function start(): Promise<void> {
  const runtime = await api.getCaptureRuntime()
  if (!runtime) throw new Error('没有活动采集会话')
  stream = await navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: { frameRate: { ideal: 1, max: 2 } }
  })
  video.srcObject = stream
  await waitForVideo()
  await video.play()
  await loop(runtime)
}

window.addEventListener('beforeunload', () => {
  stopped = true
  for (const track of stream?.getTracks() ?? []) track.stop()
})

void start().catch((error) => console.error('Capture startup failed', error))
