export type OverlayFontFamily = 'sans' | 'cjk' | 'mono'
export type OverlayFontWeight = 400 | 500 | 600

export interface OverlayStyleSettings {
  schemaVersion: 2
  fontFamily: OverlayFontFamily
  fontSizePx: number
  fontWeight: OverlayFontWeight
  textColor: string
  backgroundOpacity: number
  speedMultiplier: number
}

export const DEFAULT_OVERLAY_STYLE: Readonly<OverlayStyleSettings> = Object.freeze({
  schemaVersion: 2,
  fontFamily: 'sans',
  fontSizePx: 22,
  fontWeight: 500,
  textColor: '#F4F8F5',
  backgroundOpacity: 0.88,
  speedMultiplier: 1
})

export const MIN_OVERLAY_SPEED = 0.5
export const MAX_OVERLAY_SPEED = 2
export const OVERLAY_SPEED_STEP = 0.1
export const FALLBACK_DANMAKU_DURATION_MS = 7200

export const OVERLAY_FONT_STACKS: Record<OverlayFontFamily, string> = {
  sans: "'IBM Plex Sans', 'Noto Sans SC', sans-serif",
  cjk: "'Noto Sans SC', 'IBM Plex Sans', sans-serif",
  mono: "'JetBrains Mono', 'Noto Sans SC', monospace"
}

export type OverlayStyleVariables = Record<
  | '--danmaku-font-family'
  | '--danmaku-font-size'
  | '--danmaku-font-weight'
  | '--danmaku-text-color'
  | '--danmaku-background',
  string
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOverlayStyleFields(
  value: Record<string, unknown>,
  speedMultiplier: unknown
): OverlayStyleSettings {
  if (!['sans', 'cjk', 'mono'].includes(String(value.fontFamily))) {
    throw new Error('弹幕字体不在允许列表中')
  }
  if (!Number.isInteger(value.fontSizePx) || Number(value.fontSizePx) < 14 || Number(value.fontSizePx) > 48) {
    throw new Error('弹幕字号必须是 14–48 之间的整数')
  }
  if (![400, 500, 600].includes(Number(value.fontWeight))) {
    throw new Error('弹幕字重只能是 400、500 或 600')
  }
  const textColor = String(value.textColor ?? '').toUpperCase()
  if (!/^#[0-9A-F]{6}$/.test(textColor)) throw new Error('文字颜色必须是 #RRGGBB 格式')
  if (
    typeof value.backgroundOpacity !== 'number' ||
    !Number.isFinite(value.backgroundOpacity) ||
    value.backgroundOpacity < 0 ||
    value.backgroundOpacity > 1
  ) {
    throw new Error('背景不透明度必须在 0–1 之间')
  }
  if (
    typeof speedMultiplier !== 'number' ||
    !Number.isFinite(speedMultiplier) ||
    speedMultiplier < MIN_OVERLAY_SPEED ||
    speedMultiplier > MAX_OVERLAY_SPEED ||
    Math.abs(speedMultiplier / OVERLAY_SPEED_STEP - Math.round(speedMultiplier / OVERLAY_SPEED_STEP)) >
      Number.EPSILON * 10
  ) {
    throw new Error('弹幕速度必须是 0.5–2.0 之间且步进为 0.1 的数值')
  }

  return {
    schemaVersion: 2,
    fontFamily: value.fontFamily as OverlayFontFamily,
    fontSizePx: Number(value.fontSizePx),
    fontWeight: Number(value.fontWeight) as OverlayFontWeight,
    textColor,
    backgroundOpacity: value.backgroundOpacity,
    speedMultiplier
  }
}

export function parseOverlayStyleSettings(value: unknown): OverlayStyleSettings {
  if (!isRecord(value)) throw new Error('弹幕样式必须是对象')
  if (value.schemaVersion !== 2) throw new Error('不支持的弹幕样式版本')
  return parseOverlayStyleFields(value, value.speedMultiplier)
}

export function migrateOverlayStyleSettings(value: unknown): OverlayStyleSettings {
  if (!isRecord(value)) throw new Error('弹幕样式必须是对象')
  if (value.schemaVersion === 1) return parseOverlayStyleFields(value, 1)
  return parseOverlayStyleSettings(value)
}

export function effectiveDanmakuDuration(
  baseDuration: unknown,
  speedMultiplier: number
): number {
  const parsedDuration = Number(baseDuration)
  const duration =
    Number.isFinite(parsedDuration) && parsedDuration > 0
      ? parsedDuration
      : FALLBACK_DANMAKU_DURATION_MS
  const speed =
    Number.isFinite(speedMultiplier) &&
    speedMultiplier >= MIN_OVERLAY_SPEED &&
    speedMultiplier <= MAX_OVERLAY_SPEED
      ? speedMultiplier
      : 1
  return Math.round(duration / speed)
}

export function cloneDefaultOverlayStyle(): OverlayStyleSettings {
  return { ...DEFAULT_OVERLAY_STYLE }
}

export function overlayStyleVariables(settings: OverlayStyleSettings): OverlayStyleVariables {
  return {
    '--danmaku-font-family': OVERLAY_FONT_STACKS[settings.fontFamily],
    '--danmaku-font-size': `${settings.fontSizePx}px`,
    '--danmaku-font-weight': String(settings.fontWeight),
    '--danmaku-text-color': settings.textColor,
    '--danmaku-background': `rgba(16, 21, 18, ${settings.backgroundOpacity})`
  }
}
