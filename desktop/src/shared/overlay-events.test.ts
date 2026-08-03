import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from './contracts'
import { shouldForwardEventToOverlay } from './overlay-events'

function event(sessionId?: string): EventEnvelope {
  return {
    schema_version: '1',
    event_id: 'event-id',
    type: 'danmaku.created',
    session_id: sessionId,
    emitted_at: '2026-08-02T00:00:00.000Z',
    payload: {}
  }
}

describe('覆盖层事件过滤', () => {
  it('允许当前会话弹幕', () => {
    expect(shouldForwardEventToOverlay(event('current'), 'current')).toBe(true)
  })

  it('拒绝旧会话和停止后的弹幕', () => {
    expect(shouldForwardEventToOverlay(event('old'), 'current')).toBe(false)
    expect(shouldForwardEventToOverlay(event('old'), undefined)).toBe(false)
  })

  it('允许没有会话 ID 的覆盖层自检弹幕', () => {
    expect(shouldForwardEventToOverlay(event(), undefined)).toBe(true)
  })
})
