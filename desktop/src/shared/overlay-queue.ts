import { chooseLane } from './danmaku'

export interface OverlayMessage {
  id: string
  text: string
  lane: number
  createdAt: number
  duration: number
  tone: OverlayTone
}

export type OverlayTone = 'signal' | 'warning' | 'danger'

export interface OverlayMessageInput {
  id: string
  text: string
  duration: number
  createdAt?: number
  tone?: OverlayTone
}

export interface OverlayScheduler {
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

export class OverlayMessageQueue {
  private items: OverlayMessage[] = []
  private readonly timers = new Map<string, unknown>()
  private generation = 0

  constructor(
    private readonly onChange: (items: OverlayMessage[]) => void,
    private readonly scheduler: OverlayScheduler,
    private readonly laneCount = 7
  ) {}

  get snapshot(): OverlayMessage[] {
    return [...this.items]
  }

  add(input: OverlayMessageInput): void {
    this.remove(input.id)
    const message: OverlayMessage = {
      ...input,
      createdAt: input.createdAt ?? Date.now(),
      lane: chooseLane(this.items, this.laneCount),
      tone: input.tone ?? 'signal'
    }
    this.items = [...this.items, message]
    this.publish()

    const generation = this.generation
    const handle = this.scheduler.setTimeout(() => {
      if (generation !== this.generation) return
      this.timers.delete(message.id)
      this.items = this.items.filter((item) => item.id !== message.id)
      this.publish()
    }, message.duration + 250)
    this.timers.set(message.id, handle)
  }

  clear(): void {
    this.generation += 1
    for (const handle of this.timers.values()) this.scheduler.clearTimeout(handle)
    this.timers.clear()
    this.items = []
    this.publish()
  }

  dispose(): void {
    this.clear()
  }

  private remove(id: string): void {
    const handle = this.timers.get(id)
    if (handle !== undefined) this.scheduler.clearTimeout(handle)
    this.timers.delete(id)
    this.items = this.items.filter((item) => item.id !== id)
  }

  private publish(): void {
    this.onChange([...this.items])
  }
}
