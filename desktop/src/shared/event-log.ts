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

function recognitionGenerationSummary(event: EventEnvelope): string | undefined {
  if (event.type !== 'recognition.detected') return undefined
  const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : ''
  const evaluation = recordValue(event.payload.generation_evaluation)
  const status = evaluation?.status
  if (!text || typeof status !== 'string') return text || undefined
  if (status === 'calling') return `${text} · 已提交 AI`
  if (status === 'generated') return `${text} · AI 已生成弹幕`
  if (status === 'not_selected') return `${text} · 本帧未选中`
  if (status === 'cloud_unavailable') return `${text} · AI 未配置`
  if (status === 'repeat_limited') return `${text} · 相同文字冷却中`
  if (status === 'interval_limited') return `${text} · 调用间隔限制`
  if (status === 'rate_limited') return `${text} · 每分钟调用已达上限`
  if (status === 'failed') return `${text} · AI 调用失败：${String(evaluation?.reason ?? 'unknown')}`
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
  const recognitionSummary = recognitionGenerationSummary(event)
  if (recognitionSummary) return recognitionSummary
  for (const key of ['text', 'status', 'message'] as const) {
    const value = event.payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return '事件已接收'
}
