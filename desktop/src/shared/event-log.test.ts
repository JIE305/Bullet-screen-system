import { describe, expect, it } from 'vitest'
import type { EventEnvelope, EventType } from './contracts'
import {
  DEFAULT_EVENT_LOG_FILTER,
  MAX_EVENT_LOG_ENTRIES,
  clearEvents,
  filterEvents,
  getDanmakuText,
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
  it('默认只展示最终进入覆盖层的弹幕事件', () => {
    expect(DEFAULT_EVENT_LOG_FILTER).toBe('danmaku')
  })

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

  it('最近事件与覆盖层共用同一份弹幕文本', () => {
    const danmaku = event('5', 'danmaku.created', { text: '  规则生成的弹幕  ' })
    expect(getDanmakuText(danmaku)).toBe('规则生成的弹幕')
    expect(getEventSummary(danmaku)).toBe(getDanmakuText(danmaku))

    const malformed = event('6', 'danmaku.created', { text: { unexpected: true } })
    expect(getDanmakuText(malformed)).toBe('弹幕内容为空')
    expect(getEventSummary(malformed)).toBe('弹幕内容为空')
  })

  it('解释识别结果为何没有或已经生成弹幕', () => {
    const recognition = (id: string, generation_evaluation: Record<string, unknown>) =>
      event(id, 'recognition.detected', { text: '胜利', generation_evaluation })

    expect(getEventSummary(recognition('7', { status: 'calling' }))).toBe('胜利 · 已提交 AI')
    expect(getEventSummary(recognition('8', { status: 'generated' }))).toBe('胜利 · AI 已生成弹幕')
    expect(getEventSummary(recognition('9', { status: 'not_selected' }))).toBe('胜利 · 本帧未选中')
    expect(getEventSummary(recognition('10', { status: 'cloud_unavailable' }))).toBe('胜利 · AI 未配置')
    expect(getEventSummary(recognition('11', { status: 'repeat_limited' }))).toBe('胜利 · 相同文字冷却中')
    expect(getEventSummary(recognition('12', { status: 'interval_limited' }))).toBe('胜利 · 调用间隔限制')
    expect(getEventSummary(recognition('13', { status: 'rate_limited' }))).toBe('胜利 · 每分钟调用已达上限')
    expect(getEventSummary(recognition('14', { status: 'failed', reason: 'timeout' }))).toBe(
      '胜利 · AI 调用失败：timeout'
    )
  })

  it('相同识别事件的最终状态更新不会产生重复日志', () => {
    const calling = event('same-id', 'recognition.detected', {
      text: '胜利', generation_evaluation: { status: 'calling' }
    })
    const generated = event('same-id', 'recognition.detected', {
      text: '胜利', generation_evaluation: { status: 'generated' }
    })
    const events = prependEvent(prependEvent([], calling), generated)
    expect(events).toHaveLength(1)
    expect(getEventSummary(events[0])).toBe('胜利 · AI 已生成弹幕')
  })
})
