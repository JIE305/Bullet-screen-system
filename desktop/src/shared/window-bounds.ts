export interface WindowBoundsLike {
  x: number
  y: number
  width: number
  height: number
}

export function boundsEqual(
  current: WindowBoundsLike | undefined,
  next: WindowBoundsLike
): boolean {
  return Boolean(
    current &&
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
  )
}

export function isWindowUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('404 ')
}
