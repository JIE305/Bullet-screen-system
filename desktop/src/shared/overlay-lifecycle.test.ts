import { describe, expect, it, vi } from 'vitest'
import { disposeOverlayWindow, type DisposableOverlayWindow } from './overlay-lifecycle'

describe('覆盖层会话生命周期', () => {
  it('先隐藏旧纹理，再销毁整个 Renderer', () => {
    const calls: string[] = []
    const window: DisposableOverlayWindow = {
      isDestroyed: () => false,
      setOpacity: vi.fn((opacity) => calls.push(`opacity:${opacity}`)),
      hide: vi.fn(() => calls.push('hide')),
      destroy: vi.fn(() => calls.push('destroy'))
    }

    disposeOverlayWindow(window)

    expect(calls).toEqual(['opacity:0', 'hide', 'destroy'])
  })

  it('对空窗口和已销毁窗口保持幂等', () => {
    disposeOverlayWindow(null)
    const window: DisposableOverlayWindow = {
      isDestroyed: () => true,
      setOpacity: vi.fn(),
      hide: vi.fn(),
      destroy: vi.fn()
    }

    disposeOverlayWindow(window)

    expect(window.setOpacity).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
    expect(window.destroy).not.toHaveBeenCalled()
  })
})
