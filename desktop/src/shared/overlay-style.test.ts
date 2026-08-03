import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERLAY_STYLE,
  overlayStyleVariables,
  parseOverlayStyleSettings
} from './overlay-style'

describe('弹幕样式设置', () => {
  it('接受边界值并统一 HEX 大小写', () => {
    expect(
      parseOverlayStyleSettings({
        schemaVersion: 1,
        fontFamily: 'mono',
        fontSizePx: 14,
        fontWeight: 400,
        textColor: '#a7e46b',
        backgroundOpacity: 0
      })
    ).toMatchObject({ fontSizePx: 14, textColor: '#A7E46B', backgroundOpacity: 0 })

    expect(
      parseOverlayStyleSettings({ ...DEFAULT_OVERLAY_STYLE, fontSizePx: 48, backgroundOpacity: 1 })
    ).toMatchObject({ fontSizePx: 48, backgroundOpacity: 1 })
  })

  it.each([
    [{ ...DEFAULT_OVERLAY_STYLE, fontFamily: 'system' }, '字体'],
    [{ ...DEFAULT_OVERLAY_STYLE, fontSizePx: 13 }, '字号'],
    [{ ...DEFAULT_OVERLAY_STYLE, fontSizePx: 49 }, '字号'],
    [{ ...DEFAULT_OVERLAY_STYLE, fontWeight: 700 }, '字重'],
    [{ ...DEFAULT_OVERLAY_STYLE, textColor: '#FFF' }, '颜色'],
    [{ ...DEFAULT_OVERLAY_STYLE, backgroundOpacity: 1.1 }, '不透明度']
  ])('拒绝非法值 %#', (value, message) => {
    expect(() => parseOverlayStyleSettings(value)).toThrow(message)
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
