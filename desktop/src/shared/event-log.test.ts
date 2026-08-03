import { describe, expect, it } from 'vitest'
import type { EventEnvelope, EventType } from './contracts'
import {
  MAX_EVENT_LOG_ENTRIES,
  clearEvents,
  filterEvents,
  getEventSummary,
  prependEvent,
  removeEvent
} from './event-log'

function event(id: string, type: EventType = 'session.status', payload = {}): EventEnvelope {
  return {
    schema_version: '1',
    event_id: id,
    type,
    emitted_at: '2026-08-02T04:00:00.000Z',
    payload
  }
}

describe('本地最近事件日志', () => {
  it('新事件置顶、按 ID 去重并限制为 30 条', () => {
    let events: EventEnvelope[] = []
    for (let index = 0; index < MAX_EVENT_LOG_ENTRIES + 2; index += 1) {
      events = prependEvent(events, event(`event-${index}`))
    }
    expect(events).toHaveLength(MAX_EVENT_LOG_ENTRIES)
    expect(events[0].event_id).toBe('event-31')
    expect(events.at(-1)?.event_id).toBe('event-2')

    events = prependEvent(events, event('event-10', 'error', { message: '更新内容' }))
    expect(events).toHaveLength(MAX_EVENT_LOG_ENTRIES)
    expect(events[0]).toMatchObject({ event_id: 'event-10', type: 'error' })
    expect(events.filter((item) => item.event_id === 'event-10')).toHaveLength(1)
  })

  it('支持全部与弹幕筛选', () => {
    const events = [event('1'), event('2', 'danmaku.created'), event('3', 'error')]
    expect(filterEvents(events, 'all')).toHaveLength(3)
    expect(filterEvents(events, 'danmaku').map((item) => item.event_id)).toEqual(['2'])
  })

  it('可移除单条记录', () => {
    expect(removeEvent([event('1'), event('2')], '1').map((item) => item.event_id)).toEqual(['2'])
  })

  it('按当前筛选清空，清空弹幕后保留其他事件', () => {
    const events = [event('1'), event('2', 'danmaku.created'), event('3', 'error')]
    expect(clearEvents(events, 'danmaku').map((item) => item.event_id)).toEqual(['1', '3'])
    expect(clearEvents(events, 'all')).toEqual([])
  })

  it('按 text、status、message 的优先级生成摘要并提供默认文本', () => {
    expect(getEventSummary(event('1', 'error', { text: '文本', status: '状态', message: '消息' }))).toBe('文本')
    expect(getEventSummary(event('2', 'error', { status: '状态', message: '消息' }))).toBe('状态')
    expect(getEventSummary(event('3', 'error', { message: '消息' }))).toBe('消息')
    expect(getEventSummary(event('4', 'error', { text: '   ' }))).toBe('事件已接收')
  })
})
