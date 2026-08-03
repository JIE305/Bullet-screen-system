import { describe, expect, it } from 'vitest'
import { chooseLane } from './danmaku'

describe('chooseLane', () => {
  it('uses the oldest available lane', () => {
    expect(
      chooseLane(
        [
          { lane: 0, createdAt: 30 },
          { lane: 1, createdAt: 10 },
          { lane: 2, createdAt: 20 }
        ],
        3
      )
    ).toBe(1)
  })

  it('returns lane zero for an invalid lane count', () => {
    expect(chooseLane([], 0)).toBe(0)
  })
})

