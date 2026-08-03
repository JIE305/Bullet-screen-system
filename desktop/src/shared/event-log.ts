import type { EventEnvelope } from './contracts'

export const MAX_EVENT_LOG_ENTRIES = 30

export type EventLogFilter = 'all' | 'danmaku'

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
  for (const key of ['text', 'status', 'message'] as const) {
    const value = event.payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return '事件已接收'
}
