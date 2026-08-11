export type PreprocessMode = 'original' | 'high_contrast'
export type RuleMatchType = 'contains' | 'exact'

export interface RoiSettings {
  x: number
  y: number
  width: number
  height: number
}

export interface RuleSettings {
  id?: string
  matchType: RuleMatchType
  pattern: string
  template: string
  confidence: number
  cooldownMs: number
  enabled: boolean
}

export interface CaptureStartOptions {
  sourceId: string
  gameName: string
  region: RoiSettings
  preprocessMode: PreprocessMode
}

export type SavedCaptureSettings = Omit<CaptureStartOptions, 'sourceId'>

export const DEFAULT_ROI: RoiSettings = { x: 0.1, y: 0.2, width: 0.8, height: 0.6 }
export const DEFAULT_RULE: RuleSettings = {
  matchType: 'contains',
  pattern: '测试',
  template: '识别到：{text}',
  confidence: 0.65,
  cooldownMs: 5000,
  enabled: true
}
function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

export function parseCaptureStartOptions(value: unknown): CaptureStartOptions {
  if (!value || typeof value !== 'object') throw new TypeError('采集设置无效')
  const candidate = value as Partial<CaptureStartOptions>
  if (typeof candidate.sourceId !== 'string' || !candidate.sourceId || candidate.sourceId.length > 512) {
    throw new TypeError('捕获源 ID 无效')
  }
  if (typeof candidate.gameName !== 'string' || candidate.gameName.trim().length > 120) {
    throw new TypeError('游戏名称不能超过 120 个字符')
  }
  const region = candidate.region
  if (
    !region ||
    !finiteInRange(region.x, 0, 1) ||
    !finiteInRange(region.y, 0, 1) ||
    !finiteInRange(region.width, 0.02, 1) ||
    !finiteInRange(region.height, 0.02, 1) ||
    region.x + region.width > 1.000001 ||
    region.y + region.height > 1.000001
  ) {
    throw new TypeError('ROI 必须位于画面范围内且宽高不少于 2%')
  }
  if (candidate.preprocessMode !== 'original' && candidate.preprocessMode !== 'high_contrast') {
    throw new TypeError('预处理模式无效')
  }
  return {
    sourceId: candidate.sourceId,
    gameName: candidate.gameName.trim(),
    region: { ...region },
    preprocessMode: candidate.preprocessMode
  }
}
