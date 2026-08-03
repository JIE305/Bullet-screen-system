export interface OverlayZOrderWindow {
  isDestroyed(): boolean
  showInactive(): void
  setAlwaysOnTop(flag: boolean): void
  moveTop(): void
}

export function restoreOverlayZOrder(window: OverlayZOrderWindow): void {
  if (window.isDestroyed()) return
  window.showInactive()
  window.setAlwaysOnTop(true)
  window.moveTop()
}
