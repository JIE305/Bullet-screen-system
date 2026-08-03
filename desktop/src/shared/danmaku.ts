export interface LaneItem {
  lane: number
  createdAt: number
}

export function chooseLane(items: LaneItem[], laneCount: number): number {
  if (laneCount <= 0) return 0
  const newestByLane = Array.from({ length: laneCount }, () => 0)
  for (const item of items) {
    if (item.lane >= 0 && item.lane < laneCount) {
      newestByLane[item.lane] = Math.max(newestByLane[item.lane], item.createdAt)
    }
  }
  let result = 0
  for (let lane = 1; lane < newestByLane.length; lane += 1) {
    if (newestByLane[lane] < newestByLane[result]) result = lane
  }
  return result
}

