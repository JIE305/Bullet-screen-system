import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLOUD_SYSTEM_PROMPT,
  normalizeCloudBaseUrl,
  parseCloudApiSettingsUpdate
} from './cloud-api'

function validInput() {
  return {
    enabled: true,
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'secret',
    model: 'demo-model',
    systemPrompt: DEFAULT_CLOUD_SYSTEM_PROMPT,
    timeoutMs: 5000,
    maxCallsPerMinute: 10
  }
}

describe('云端 API 配置校验', () => {
  it('规范化 HTTPS 与本机 HTTP 地址', () => {
    expect(normalizeCloudBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeCloudBaseUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1')
    expect(() => normalizeCloudBaseUrl('http://api.example.com/v1')).toThrow(/HTTPS/)
  })

  it('启用时要求地址、模型与密钥完整', () => {
    expect(parseCloudApiSettingsUpdate(validInput(), false)).toMatchObject({
      enabled: true,
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'secret'
    })
    const withoutKey = { ...validInput(), apiKey: undefined }
    expect(() => parseCloudApiSettingsUpdate(withoutKey, false)).toThrow(/API Key/)
    expect(parseCloudApiSettingsUpdate(withoutKey, true).enabled).toBe(true)
  })

  it('拒绝超时、限额与提示词非法值', () => {
    expect(() => parseCloudApiSettingsUpdate({ ...validInput(), timeoutMs: 2000 }, false)).toThrow()
    expect(() => parseCloudApiSettingsUpdate({ ...validInput(), maxCallsPerMinute: 61 }, false)).toThrow()
    expect(() => parseCloudApiSettingsUpdate({ ...validInput(), systemPrompt: '' }, false)).toThrow()
  })

  it('删除密钥时不能保持启用', () => {
    expect(() => parseCloudApiSettingsUpdate({ ...validInput(), apiKey: undefined, deleteApiKey: true }, true)).toThrow(/API Key/)
  })
})
