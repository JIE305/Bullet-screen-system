import { describe, expect, it } from 'vitest'
import { DEFAULT_ROI, DEFAULT_RULE, parseCaptureStartOptions, parseGlobalRules } from './capture-settings'

describe('采集设置校验', () => {
  const valid = {
    sourceId: 'window:1:0',
    region: DEFAULT_ROI,
    preprocessMode: 'original' as const
  }

  it('接受合法 ROI', () => {
    expect(parseCaptureStartOptions(valid)).toEqual(valid)
  })

  it('拒绝越界和过小 ROI', () => {
    expect(() => parseCaptureStartOptions({ ...valid, region: { x: 0.9, y: 0, width: 0.2, height: 1 } })).toThrow(/ROI/)
    expect(() => parseCaptureStartOptions({ ...valid, region: { x: 0, y: 0, width: 0.01, height: 1 } })).toThrow(/ROI/)
  })

  it('拒绝空关键词和缺少 text 占位符的模板', () => {
    expect(() => parseGlobalRules([{ ...DEFAULT_RULE, pattern: '' }])).toThrow(/规则/)
    expect(() => parseGlobalRules([{ ...DEFAULT_RULE, template: '固定文字' }])).toThrow(/规则/)
  })

  it('接受多条全局规则并拒绝非法列表', () => {
    const rules = [DEFAULT_RULE, { ...DEFAULT_RULE, pattern: '胜利', template: '{text}' }]
    expect(parseGlobalRules(rules)).toEqual(rules)
    expect(() => parseGlobalRules({ rules })).toThrow(/列表/)
  })
})
