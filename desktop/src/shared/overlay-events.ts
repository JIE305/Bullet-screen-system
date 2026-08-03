import type { EventEnvelope } from './contracts'

export function shouldForwardEventToOverlay(
  event: EventEnvelope,
  activeSessionId: string | undefined
): boolean {
  if (event.type !== 'danmaku.created' || !event.session_id) return true
  return event.session_id === activeSessionId
}
