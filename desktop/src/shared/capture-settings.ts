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
export const OBSERVE_ONLY_RULE: RuleSettings = {
  matchType: 'contains',
  pattern: '',
  template: '{text}',
  confidence: 0.65,
  cooldownMs: 5000,
  enabled: true
}

export function createRuleSettings(): RuleSettings {
  return { ...OBSERVE_ONLY_RULE }
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
    region: { ...region },
    preprocessMode: candidate.preprocessMode
  }
}

export function parseRuleSettings(value: unknown): RuleSettings {
  if (!value || typeof value !== 'object') throw new TypeError('弹幕规则无效')
  const rule = value as Partial<RuleSettings>
  const cooldownMs = rule.cooldownMs
  if (
    (rule.matchType !== 'contains' && rule.matchType !== 'exact') ||
    (rule.id !== undefined && (typeof rule.id !== 'string' || !rule.id || rule.id.length > 80)) ||
    typeof rule.pattern !== 'string' ||
    !rule.pattern.trim() ||
    rule.pattern.length > 200 ||
    typeof rule.template !== 'string' ||
    !rule.template.includes('{text}') ||
    rule.template.length > 240 ||
    !finiteInRange(rule.confidence, 0, 1) ||
    !Number.isInteger(cooldownMs) ||
    typeof cooldownMs !== 'number' ||
    cooldownMs < 0 ||
    cooldownMs > 60000 ||
    typeof rule.enabled !== 'boolean'
  ) {
    throw new TypeError('弹幕规则无效')
  }
  return {
    ...(rule.id ? { id: rule.id } : {}),
    matchType: rule.matchType,
    pattern: rule.pattern.trim(),
    template: rule.template.trim(),
    confidence: rule.confidence,
    cooldownMs,
    enabled: rule.enabled
  }
}

export function parseGlobalRules(value: unknown): RuleSettings[] {
  if (!Array.isArray(value)) throw new TypeError('全局规则列表无效')
  return value.map(parseRuleSettings)
}
