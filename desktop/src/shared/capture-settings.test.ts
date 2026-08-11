import { describe, expect, it } from 'vitest'
import { DEFAULT_ROI, parseCaptureStartOptions } from './capture-settings'

describe('采集设置校验', () => {
  const valid = {
    sourceId: 'window:1:0',
    gameName: '英雄联盟',
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

  it('规范化游戏名称并拒绝过长名称', () => {
    expect(parseCaptureStartOptions({ ...valid, gameName: '  英雄联盟  ' }).gameName).toBe('英雄联盟')
    expect(() => parseCaptureStartOptions({ ...valid, gameName: '游'.repeat(121) })).toThrow(/游戏名称/)
  })
})
