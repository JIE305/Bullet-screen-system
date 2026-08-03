import { describe, expect, it } from 'vitest'
import { OverlayMessageQueue, type OverlayScheduler } from './overlay-queue'

function makeScheduler() {
  let nextHandle = 1
  const callbacks = new Map<number, () => void>()
  const cleared: number[] = []
  const scheduler: OverlayScheduler = {
    setTimeout(callback) {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    },
    clearTimeout(handle) {
      cleared.push(handle as number)
      callbacks.delete(handle as number)
    }
  }
  return { scheduler, callbacks, cleared }
}

describe('覆盖层弹幕队列', () => {
  it('清空消息并取消所有删除定时器', () => {
    const fake = makeScheduler()
    const queue = new OverlayMessageQueue(() => undefined, fake.scheduler)
    queue.add({ id: 'a', text: 'A', duration: 1000 })
    queue.add({ id: 'b', text: 'B', duration: 1000 })

    queue.clear()

    expect(queue.snapshot).toEqual([])
    expect(fake.cleared).toEqual([1, 2])
    expect(fake.callbacks.size).toBe(0)
  })

  it('旧世代回调不能删除新会话消息', () => {
    const fake = makeScheduler()
    const queue = new OverlayMessageQueue(() => undefined, fake.scheduler)
    queue.add({ id: 'old', text: '旧会话', duration: 1000 })
    const staleCallback = fake.callbacks.get(1)
    queue.clear()
    queue.add({ id: 'new', text: '新会话', duration: 1000 })

    staleCallback?.()

    expect(queue.snapshot.map((item) => item.id)).toEqual(['new'])
  })

  it('重复清空保持幂等', () => {
    const fake = makeScheduler()
    const updates: number[] = []
    const queue = new OverlayMessageQueue((items) => updates.push(items.length), fake.scheduler)

    queue.clear()
    queue.clear()

    expect(queue.snapshot).toEqual([])
    expect(updates).toEqual([0, 0])
  })
})
