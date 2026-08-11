import { describe, expect, it, vi } from 'vitest'
import { restoreOverlayZOrder, type OverlayZOrderWindow } from './overlay-z-order'

describe('覆盖层 Z-order', () => {
  it('不抢焦点地显示并恢复到置顶层顶部', () => {
    const calls: string[] = []
    const window: OverlayZOrderWindow = {
      isDestroyed: () => false,
      showInactive: vi.fn(() => calls.push('showInactive')),
      setAlwaysOnTop: vi.fn((flag, level) => calls.push(`setAlwaysOnTop:${flag}:${level}`)),
      moveTop: vi.fn(() => calls.push('moveTop'))
    }

    restoreOverlayZOrder(window)

    expect(calls).toEqual(['showInactive', 'moveTop', 'setAlwaysOnTop:true:screen-saver'])
  })

  it('不会操作已经销毁的窗口', () => {
    const window: OverlayZOrderWindow = {
      isDestroyed: () => true,
      showInactive: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      moveTop: vi.fn()
    }

    restoreOverlayZOrder(window)

    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled()
    expect(window.moveTop).not.toHaveBeenCalled()
  })
})
