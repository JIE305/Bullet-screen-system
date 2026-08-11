import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLOUD_SYSTEM_PROMPT, LEGACY_CLOUD_SYSTEM_PROMPT } from '../shared/cloud-api'
import { CloudApiStore, type SecretStorageAdapter } from './cloud-api-store'

const temporaryDirectories: string[] = []

function adapter(available = true): SecretStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}

async function makeStore(secrets = adapter(), warn = vi.fn()) {
  const directory = await mkdtemp(join(tmpdir(), 'damu-cloud-api-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'cloud-api.json')
  return { store: new CloudApiStore(path, secrets, warn), path, warn }
}

function update(apiKey = 'top-secret') {
  return {
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    apiKey,
    model: 'demo-model',
    systemPrompt: DEFAULT_CLOUD_SYSTEM_PROMPT,
    timeoutMs: 5000,
    minConfidence: 0.7,
    minIntervalMs: 12000,
    repeatCooldownMs: 30000,
    maxCallsPerMinute: 4
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('云端 API 密钥存储', () => {
  it('首次启动使用默认值，保存文件不含明文密钥，重载后可以解密', async () => {
    const { store, path } = await makeStore()
    expect((await store.load()).hasApiKey).toBe(false)
    const saved = await store.save(update())
    expect(saved).toMatchObject({ enabled: true, hasApiKey: true, secretStorage: 'encrypted' })
    const file = await readFile(path, 'utf8')
    expect(file).not.toContain('top-secret')
    const reloaded = new CloudApiStore(path, adapter())
    expect(await reloaded.load()).toMatchObject({ enabled: true, hasApiKey: true })
    expect(reloaded.getSecretConfig().api_key).toBe('top-secret')
  })

  it('渲染端公开配置不返回密钥', async () => {
    const { store } = await makeStore()
    await store.load()
    await store.save(update())
    expect(JSON.stringify(store.getPublic())).not.toContain('top-secret')
    expect(store.getPublic()).not.toHaveProperty('apiKey')
  })

  it('删除密钥会清除持久化密文并自动停用', async () => {
    const { store, path } = await makeStore()
    await store.load()
    await store.save(update())
    const deleted = await store.save({ ...update(''), enabled: false, deleteApiKey: true })
    expect(deleted).toMatchObject({ enabled: false, hasApiKey: false, secretStorage: 'none' })
    expect(await readFile(path, 'utf8')).not.toContain('encryptedApiKey')
    expect(store.getSecretConfig().api_key).toBe('')
  })

  it('系统加密不可用时密钥只留在内存并明确警告', async () => {
    const warn = vi.fn()
    const { store, path } = await makeStore(adapter(false), warn)
    await store.load()
    const saved = await store.save(update())
    expect(saved).toMatchObject({ hasApiKey: true, secretStorage: 'memory' })
    expect(await readFile(path, 'utf8')).not.toContain('encryptedApiKey')
    expect(warn).toHaveBeenCalled()
    const restarted = new CloudApiStore(path, adapter(false))
    expect(await restarted.load()).toMatchObject({ enabled: false, hasApiKey: false })
  })

  it('损坏文件回退默认值且不泄露此前内存密钥', async () => {
    const warn = vi.fn()
    const { store, path } = await makeStore(adapter(), warn)
    await writeFile(path, '{broken', 'utf8')
    expect(await store.load()).toMatchObject({ enabled: false, hasApiKey: false })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('旧版默认提示词自动迁移到 v3 OCR 直连提示词并补充保守策略', async () => {
    const { store, path } = await makeStore()
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      enabled: false,
      baseUrl: '',
      model: '',
      systemPrompt: LEGACY_CLOUD_SYSTEM_PROMPT,
      timeoutMs: 5000,
      maxCallsPerMinute: 10
    }), 'utf8')
    const loaded = await store.load()
    expect(loaded.schemaVersion).toBe(3)
    expect(loaded.systemPrompt).toBe(DEFAULT_CLOUD_SYSTEM_PROMPT)
    expect(loaded).toMatchObject({
      minConfidence: 0.7,
      minIntervalMs: 12000,
      repeatCooldownMs: 30000,
      maxCallsPerMinute: 10
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      systemPrompt: DEFAULT_CLOUD_SYSTEM_PROMPT
    })
  })

  it('v2 配置迁移时把过高的每分钟上限收紧到 12', async () => {
    const { store, path } = await makeStore()
    await writeFile(path, JSON.stringify({
      schemaVersion: 2,
      enabled: false,
      baseUrl: '',
      model: '',
      systemPrompt: DEFAULT_CLOUD_SYSTEM_PROMPT,
      timeoutMs: 5000,
      maxCallsPerMinute: 60
    }), 'utf8')
    expect(await store.load()).toMatchObject({ schemaVersion: 3, maxCallsPerMinute: 12 })
  })

  it('旧版用户自定义提示词在迁移时保持不变', async () => {
    const { store, path } = await makeStore()
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      enabled: false,
      baseUrl: '',
      model: '',
      systemPrompt: '这是用户自定义的提示词',
      timeoutMs: 5000,
      maxCallsPerMinute: 10
    }), 'utf8')
    expect((await store.load()).systemPrompt).toBe('这是用户自定义的提示词')
  })
})
