import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERLAY_STYLE,
  effectiveDanmakuDuration,
  migrateOverlayStyleSettings,
  overlayStyleVariables,
  parseOverlayStyleSettings
} from './overlay-style'

describe('弹幕样式设置', () => {
  it('接受边界值并统一 HEX 大小写', () => {
    expect(
      parseOverlayStyleSettings({
        schemaVersion: 2,
        fontFamily: 'mono',
        fontSizePx: 14,
        fontWeight: 400,
        textColor: '#a7e46b',
        backgroundOpacity: 0,
        speedMultiplier: 0.5
      })
    ).toMatchObject({
      fontSizePx: 14,
      textColor: '#A7E46B',
      backgroundOpacity: 0,
      speedMultiplier: 0.5
    })

    expect(
      parseOverlayStyleSettings({
        ...DEFAULT_OVERLAY_STYLE,
        fontSizePx: 48,
        backgroundOpacity: 1,
        speedMultiplier: 2
      })
    ).toMatchObject({ fontSizePx: 48, backgroundOpacity: 1, speedMultiplier: 2 })
  })

  it.each([
    [{ ...DEFAULT_OVERLAY_STYLE, fontFamily: 'system' }, '字体'],
    [{ ...DEFAULT_OVERLAY_STYLE, fontSizePx: 13 }, '字号'],
    [{ ...DEFAULT_OVERLAY_STYLE, fontSizePx: 49 }, '字号'],
    [{ ...DEFAULT_OVERLAY_STYLE, fontWeight: 700 }, '字重'],
    [{ ...DEFAULT_OVERLAY_STYLE, textColor: '#FFF' }, '颜色'],
    [{ ...DEFAULT_OVERLAY_STYLE, backgroundOpacity: 1.1 }, '不透明度'],
    [{ ...DEFAULT_OVERLAY_STYLE, speedMultiplier: 0.4 }, '速度'],
    [{ ...DEFAULT_OVERLAY_STYLE, speedMultiplier: 2.1 }, '速度'],
    [{ ...DEFAULT_OVERLAY_STYLE, speedMultiplier: 0.55 }, '速度'],
    [{ ...DEFAULT_OVERLAY_STYLE, speedMultiplier: Number.NaN }, '速度']
  ])('拒绝非法值 %#', (value, message) => {
    expect(() => parseOverlayStyleSettings(value)).toThrow(message)
  })

  it('将旧版设置迁移为 1.0 倍速并保留原样式', () => {
    expect(
      migrateOverlayStyleSettings({
        schemaVersion: 1,
        fontFamily: 'cjk',
        fontSizePx: 30,
        fontWeight: 600,
        textColor: '#E7B75F',
        backgroundOpacity: 0.5
      })
    ).toEqual({
      schemaVersion: 2,
      fontFamily: 'cjk',
      fontSizePx: 30,
      fontWeight: 600,
      textColor: '#E7B75F',
      backgroundOpacity: 0.5,
      speedMultiplier: 1
    })
  })

  it('按速度倍率换算弹幕时长并回退非法基础时长', () => {
    expect(effectiveDanmakuDuration(7200, 0.5)).toBe(14400)
    expect(effectiveDanmakuDuration(7200, 1)).toBe(7200)
    expect(effectiveDanmakuDuration(7200, 2)).toBe(3600)
    expect(effectiveDanmakuDuration(Number.NaN, 2)).toBe(3600)
    expect(effectiveDanmakuDuration(-1, 1)).toBe(7200)
  })

  it('生成覆盖层和预览共用的 CSS 变量', () => {
    expect(overlayStyleVariables(DEFAULT_OVERLAY_STYLE)).toEqual({
      '--danmaku-font-family': "'IBM Plex Sans', 'Noto Sans SC', sans-serif",
      '--danmaku-font-size': '22px',
      '--danmaku-font-weight': '500',
      '--danmaku-text-color': '#F4F8F5',
      '--danmaku-background': 'rgba(16, 21, 18, 0.88)'
    })
  })
})
