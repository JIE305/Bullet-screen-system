import type { EventEnvelope } from './contracts'

export const MAX_EVENT_LOG_ENTRIES = 30

export type EventLogFilter = 'all' | 'danmaku'

export const DEFAULT_EVENT_LOG_FILTER: EventLogFilter = 'danmaku'

export function getDanmakuText(event: EventEnvelope): string {
  if (event.type !== 'danmaku.created') return ''
  const value = event.payload.text
  return typeof value === 'string' && value.trim() ? value.trim() : '弹幕内容为空'
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function recognitionRuleSummary(event: EventEnvelope): string | undefined {
  if (event.type !== 'recognition.detected') return undefined
  const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : ''
  const evaluation = recordValue(event.payload.rule_evaluation)
  const status = evaluation?.status
  if (!text || typeof status !== 'string') return text || undefined
  if (status === 'no_rule') return `${text} · 仅识别（尚未配置规则）`
  if (status === 'cooldown') return `${text} · 已命中，冷却中`
  if (status === 'emitted') {
    const count = Number(evaluation?.emitted_message_count)
    return `${text} · 已生成 ${Number.isFinite(count) ? count : 1} 条弹幕`
  }
  if (status === 'not_matched') {
    const configuredCount = Number(evaluation?.configured_rule_count)
    if (Number.isFinite(configuredCount) && configuredCount > 2) {
      return `${text} · 未命中（已检查 ${configuredCount} 条全局规则）`
    }
    const checks = Array.isArray(evaluation?.checks) ? evaluation.checks : []
    const rules = checks
      .map(recordValue)
      .filter((check): check is Record<string, unknown> => Boolean(check))
      .map((check) => {
        const pattern = typeof check.pattern === 'string' ? check.pattern.trim() : ''
        if (!pattern) return ''
        return `${check.match_type === 'exact' ? '完全匹配' : '包含'}“${pattern}”`
      })
      .filter(Boolean)
      .slice(0, 2)
      .join('、')
    return rules ? `${text} · 未命中（全局规则：${rules}）` : `${text} · 未命中全局规则`
  }
  return text
}

export function prependEvent(
  events: readonly EventEnvelope[],
  event: EventEnvelope,
  limit = MAX_EVENT_LOG_ENTRIES
): EventEnvelope[] {
  return [event, ...events.filter((item) => item.event_id !== event.event_id)].slice(0, limit)
}

export function filterEvents(
  events: readonly EventEnvelope[],
  filter: EventLogFilter
): EventEnvelope[] {
  if (filter === 'all') return [...events]
  return events.filter((event) => event.type === 'danmaku.created')
}

export function removeEvent(events: readonly EventEnvelope[], eventId: string): EventEnvelope[] {
  return events.filter((event) => event.event_id !== eventId)
}

export function clearEvents(
  events: readonly EventEnvelope[],
  filter: EventLogFilter
): EventEnvelope[] {
  if (filter === 'all') return []
  return events.filter((event) => event.type !== 'danmaku.created')
}

export function getEventSummary(event: EventEnvelope): string {
  if (event.type === 'danmaku.created') return getDanmakuText(event)
  const recognitionSummary = recognitionRuleSummary(event)
  if (recognitionSummary) return recognitionSummary
  for (const key of ['text', 'status', 'message'] as const) {
    const value = event.payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return '事件已接收'
}
