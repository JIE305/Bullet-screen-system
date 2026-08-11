import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  cloneDefaultCloudApiSettings,
  parseCloudApiSettingsUpdate,
  type CloudApiPublicSettings,
  type CloudApiSettingsUpdate
} from '../shared/cloud-api'

export interface SecretStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface StoredCloudApiSettings {
  schemaVersion: 1
  enabled: boolean
  baseUrl: string
  model: string
  systemPrompt: string
  timeoutMs: number
  maxCallsPerMinute: number
  encryptedApiKey?: string
}

export interface CloudApiSecretConfig {
  enabled: boolean
  base_url: string
  api_key: string
  model: string
  system_prompt: string
  timeout_ms: number
  max_calls_per_minute: number
}

export class CloudApiStore {
  private settings = cloneDefaultCloudApiSettings()
  private apiKey = ''
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly secrets: SecretStorageAdapter,
    private readonly warn: (message: string) => void = console.warn
  ) {}

  async load(): Promise<CloudApiPublicSettings> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as StoredCloudApiSettings
      if (raw.schemaVersion !== 1) throw new Error('unknown_schema_version')
      const parsed = parseCloudApiSettingsUpdate(
        {
          enabled: false,
          baseUrl: raw.baseUrl,
          model: raw.model,
          systemPrompt: raw.systemPrompt,
          timeoutMs: raw.timeoutMs,
          maxCallsPerMinute: raw.maxCallsPerMinute
        },
        false
      )
      let warning: string | undefined
      if (raw.encryptedApiKey) {
        if (this.secrets.isEncryptionAvailable()) {
          this.apiKey = this.secrets.decryptString(Buffer.from(raw.encryptedApiKey, 'base64'))
        } else {
          warning = '系统加密当前不可用，已保存的 API Key 无法读取，请本次运行重新输入。'
          this.warn(warning)
        }
      }
      this.settings = {
        schemaVersion: 1,
        enabled: raw.enabled && Boolean(this.apiKey),
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        systemPrompt: parsed.systemPrompt,
        timeoutMs: parsed.timeoutMs,
        maxCallsPerMinute: parsed.maxCallsPerMinute,
        hasApiKey: Boolean(this.apiKey),
        secretStorage: this.apiKey ? 'encrypted' : 'none',
        ...(warning ? { warning } : {})
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`云端 API 配置文件无效，已恢复默认值：${error instanceof Error ? error.message : String(error)}`)
      }
      this.settings = cloneDefaultCloudApiSettings()
      this.apiKey = ''
    }
    return this.getPublic()
  }

  getPublic(): CloudApiPublicSettings {
    return { ...this.settings, hasApiKey: Boolean(this.apiKey) }
  }

  getSecretConfig(): CloudApiSecretConfig {
    return {
      enabled: this.settings.enabled && Boolean(this.apiKey),
      base_url: this.settings.baseUrl,
      api_key: this.apiKey,
      model: this.settings.model,
      system_prompt: this.settings.systemPrompt,
      timeout_ms: this.settings.timeoutMs,
      max_calls_per_minute: this.settings.maxCallsPerMinute
    }
  }

  async save(value: unknown): Promise<CloudApiPublicSettings> {
    const parsed = parseCloudApiSettingsUpdate(value, Boolean(this.apiKey))
    if (parsed.deleteApiKey) this.apiKey = ''
    if (parsed.apiKey) this.apiKey = parsed.apiKey
    const encryptionAvailable = this.secrets.isEncryptionAvailable()
    const warning = this.apiKey && !encryptionAvailable
      ? '系统加密不可用，API Key 仅保存在本次运行内存，退出后需要重新输入。'
      : undefined
    if (warning) this.warn(warning)
    this.settings = {
      schemaVersion: 1,
      enabled: parsed.enabled && Boolean(this.apiKey),
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      systemPrompt: parsed.systemPrompt,
      timeoutMs: parsed.timeoutMs,
      maxCallsPerMinute: parsed.maxCallsPerMinute,
      hasApiKey: Boolean(this.apiKey),
      secretStorage: this.apiKey ? (encryptionAvailable ? 'encrypted' : 'memory') : 'none',
      ...(warning ? { warning } : {})
    }
    const stored: StoredCloudApiSettings = {
      schemaVersion: 1,
      enabled: this.settings.enabled,
      baseUrl: this.settings.baseUrl,
      model: this.settings.model,
      systemPrompt: this.settings.systemPrompt,
      timeoutMs: this.settings.timeoutMs,
      maxCallsPerMinute: this.settings.maxCallsPerMinute,
      ...(this.apiKey && encryptionAvailable
        ? { encryptedApiKey: this.secrets.encryptString(this.apiKey).toString('base64') }
        : {})
    }
    const persist = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.filePath)
    }
    this.writeChain = this.writeChain.catch(() => undefined).then(persist)
    await this.writeChain
    return this.getPublic()
  }
}
