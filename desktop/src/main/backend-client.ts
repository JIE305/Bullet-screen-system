import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { app } from 'electron'
import WebSocket from 'ws'
import type { EventEnvelope, FrameReceipt, FrameUpload } from '../shared/contracts'

interface ReadyMessage {
  host: string
  port: number
  api_version: string
}

export class BackendClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private baseUrl: string | null = null
  private token = ''
  private socket: WebSocket | null = null
  private startPromise: Promise<void> | null = null
  private stopping = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  async start(): Promise<void> {
    if (this.baseUrl && this.child) return
    if (this.startPromise) return this.startPromise
    this.stopping = false
    this.startPromise = this.startProcess().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startProcess(): Promise<void> {
    this.token = randomBytes(24).toString('hex')
    const backendRoot =
      process.env.DAMU_BACKEND_ROOT ?? join(app.getAppPath(), '..', 'backend')
    const dataDir = join(app.getPath('userData'), 'runtime')
    const configuredPython = process.env.DAMU_PYTHON
    const executable = app.isPackaged
      ? join(process.resourcesPath, 'backend', 'damusystem-backend.exe')
      : configuredPython || 'py'
    const args = app.isPackaged
      ? ['--port', '0', '--data-dir', dataDir]
      : [
          ...(configuredPython ? [] : ['-3.12']),
          '-m',
          'damusystem_backend',
          '--port',
          '0',
          '--data-dir',
          dataDir
        ]

    const child = spawn(executable, args, {
      cwd: backendRoot,
      windowsHide: true,
      env: {
        ...process.env,
        DAMU_AUTH_TOKEN: this.token,
        PYTHONPATH: join(backendRoot, 'src')
      }
    })
    this.child = child
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim()
      if (message) this.emit('log', message)
    })
    child.once('exit', (code, signal) => {
      const unexpected = !this.stopping
      this.baseUrl = null
      this.child = null
      this.closeSocket()
      this.emit('exit', { code, signal, unexpected })
    })

    const ready = await new Promise<ReadyMessage>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout })
      const timer = setTimeout(() => {
        lines.close()
        reject(new Error('Python 后端在 10 秒内没有报告就绪'))
      }, 10_000)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        lines.close()
        reject(error)
      }
      child.once('error', fail)
      child.once('exit', (code) => {
        if (!this.baseUrl) fail(new Error(`Python 后端提前退出：${code ?? 'unknown'}`))
      })
      lines.on('line', (line) => {
        if (!line.startsWith('DAMU_BACKEND_READY ')) return
        try {
          const parsed = JSON.parse(line.slice('DAMU_BACKEND_READY '.length)) as ReadyMessage
          clearTimeout(timer)
          resolve(parsed)
        } catch {
          fail(new Error('Python 后端 ready 消息格式无效'))
        }
      })
    })

    this.baseUrl = `http://${ready.host}:${ready.port}`
    await this.waitForHealth()
    this.connectSocket()
  }

  private async waitForHealth(): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await this.request('/api/v1/health')
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    throw lastError instanceof Error ? lastError : new Error('健康检查失败')
  }

  private connectSocket(): void {
    if (!this.baseUrl || this.stopping) return
    this.closeSocket()
    const url = this.baseUrl.replace(/^http/, 'ws') + '/ws/v1/events'
    const socket = new WebSocket(url, { headers: { 'X-DaMu-Token': this.token } })
    this.socket = socket
    socket.on('open', () => {
      this.reconnectAttempt = 0
      this.emit('connection', true)
    })
    socket.on('message', (data) => {
      try {
        this.emit('event', JSON.parse(data.toString()) as EventEnvelope)
      } catch {
        this.emit('log', '忽略无法解析的 WebSocket 消息')
      }
    })
    socket.on('error', (error) => this.emit('log', `WebSocket: ${error.message}`))
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      this.emit('connection', false)
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping || !this.baseUrl || this.reconnectTimer) return
    const delays = [500, 1000, 2000, 4000, 5000]
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)]
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectSocket()
    }, delay)
  }

  private closeSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close()
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.baseUrl) throw new Error('Python 后端尚未就绪')
    const headers = new Headers(init.headers)
    headers.set('X-DaMu-Token', this.token)
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    const response = await fetch(this.baseUrl + path, { ...init, headers })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`${response.status} ${detail || response.statusText}`)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  async uploadFrame(payload: FrameUpload): Promise<FrameReceipt> {
    const form = new FormData()
    form.set('frame_id', payload.frameId)
    form.set('region_id', payload.regionId)
    form.set('captured_at', payload.capturedAt)
    form.set('width', String(payload.width))
    form.set('height', String(payload.height))
    form.set('image', new Blob([payload.bytes], { type: 'image/jpeg' }), 'frame.jpg')
    return this.request<FrameReceipt>(`/api/v1/sessions/${payload.sessionId}/frames`, {
      method: 'POST',
      body: form
    })
  }

  async stop(): Promise<void> {
    if (!this.child) return
    this.stopping = true
    this.closeSocket()
    const child = this.child
    try {
      await this.request('/api/v1/shutdown', { method: 'POST' })
    } catch {
      // The fallback kill below handles an unavailable backend.
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000))
    ])
    if (this.child && !this.child.killed) this.child.kill()
    this.baseUrl = null
  }
}

