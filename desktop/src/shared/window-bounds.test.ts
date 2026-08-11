import { describe, expect, it } from 'vitest'
import { boundsEqual, isWindowUnavailableError } from './window-bounds'

describe('覆盖层窗口边界', () => {
  it('识别从内置测试窗口切换到不同尺寸的目标窗口', () => {
    const fixture = { x: 100, y: 100, width: 820, height: 500 }
    const selected = { x: 40, y: 60, width: 1280, height: 720 }
    expect(boundsEqual(fixture, selected)).toBe(false)
  })

  it('忽略没有变化的轮询结果', () => {
    const bounds = { x: -1200, y: 20, width: 1100, height: 700 }
    expect(boundsEqual(bounds, { ...bounds })).toBe(true)
  })

  it('仅把后端明确返回的 404 视为目标窗口消失', () => {
    expect(isWindowUnavailableError(new Error('404 {"detail":"window_unavailable"}'))).toBe(true)
    expect(isWindowUnavailableError(new Error('Python 后端尚未就绪'))).toBe(false)
    expect(isWindowUnavailableError(new Error('fetch failed'))).toBe(false)
  })
})
