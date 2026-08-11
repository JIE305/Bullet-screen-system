export interface OverlayZOrderWindow {
  isDestroyed(): boolean
  showInactive(): void
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void
  moveTop(): void
}

export function restoreOverlayZOrder(window: OverlayZOrderWindow): void {
  if (window.isDestroyed()) return
  window.showInactive()
  window.moveTop()
  // Keep this as the final Z-order operation. On Windows, moveTop() can put a
  // transparent window back in the normal band under some activation timings.
  window.setAlwaysOnTop(true, 'screen-saver')
}
