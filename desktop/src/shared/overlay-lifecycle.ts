export interface DisposableOverlayWindow {
  isDestroyed(): boolean
  setOpacity(opacity: number): void
  hide(): void
  destroy(): void
}

/**
 * Immediately removes the current compositor surface instead of keeping a
 * hidden Renderer alive. This prevents Windows from presenting a stale frame
 * when the next capture session starts.
 */
export function disposeOverlayWindow(window: DisposableOverlayWindow | null): void {
  if (!window || window.isDestroyed()) return
  window.setOpacity(0)
  window.hide()
  window.destroy()
}
