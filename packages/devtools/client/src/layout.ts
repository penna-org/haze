export interface Point {
  x: number
  y: number
}

interface LayoutOptions {
  /** 上一次的位置：刷新数据时保留，避免整张图跳动 */
  previous?: Map<string, Point>
  /** 固定位置的节点（用户拖动过） */
  pinned?: Set<string>
  iterations?: number
}

/**
 * 力导向布局（Fruchterman–Reingold）：节点互斥、连线相吸、向中心收拢。
 * 节点数在几百以内，同步迭代即可；初始位置按名字确定，同样的数据得到同样的布局。
 */
export function forceLayout(ids: readonly string[], edges: ReadonlyArray<{ from: string, to: string }>, options: LayoutOptions = {}): Map<string, Point> {
  const count = ids.length
  const positions = new Map<string, Point>()
  const area = Math.max(1, count) * 9000
  const k = Math.sqrt(area / Math.max(1, count))
  ids.forEach((id, index) => {
    const previous = options.previous?.get(id)
    if (previous) {
      positions.set(id, { ...previous })
      return
    }
    const angle = (hash(id) % 360) / 180 * Math.PI
    const radius = k * (1 + (index % 5))
    positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  })

  const links = edges.filter(edge => positions.has(edge.from) && positions.has(edge.to) && edge.from !== edge.to)
  const iterations = options.iterations ?? (options.previous?.size ? 120 : 320)
  let temperature = k * (options.previous?.size ? 0.6 : 2)
  const cooling = temperature / (iterations + 1)

  for (let step = 0; step < iterations; step++) {
    const moves = new Map<string, Point>(ids.map(id => [
      id,
      { x: 0, y: 0 },
    ]))
    for (let i = 0; i < count; i++) {
      const a = positions.get(ids[i]!)!
      const moveA = moves.get(ids[i]!)!
      for (let j = i + 1; j < count; j++) {
        const b = positions.get(ids[j]!)!
        const moveB = moves.get(ids[j]!)!
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distance = Math.hypot(dx, dy)
        if (distance < 0.01) {
          dx = 0.1 * (i - j)
          dy = 0.1
          distance = Math.hypot(dx, dy)
        }
        const force = (k * k) / distance
        moveA.x += dx / distance * force
        moveA.y += dy / distance * force
        moveB.x -= dx / distance * force
        moveB.y -= dy / distance * force
      }
    }
    for (const link of links) {
      const a = positions.get(link.from)!
      const b = positions.get(link.to)!
      const dx = a.x - b.x
      const dy = a.y - b.y
      const distance = Math.max(0.01, Math.hypot(dx, dy))
      const force = (distance * distance) / k
      const moveA = moves.get(link.from)!
      const moveB = moves.get(link.to)!
      moveA.x -= dx / distance * force
      moveA.y -= dy / distance * force
      moveB.x += dx / distance * force
      moveB.y += dy / distance * force
    }
    for (const id of ids) {
      if (options.pinned?.has(id))
        continue
      const point = positions.get(id)!
      const move = moves.get(id)!
      // 向中心的引力，防止孤立节点飘远
      move.x -= point.x * 0.05
      move.y -= point.y * 0.05
      const length = Math.max(0.01, Math.hypot(move.x, move.y))
      point.x += move.x / length * Math.min(length, temperature)
      point.y += move.y / length * Math.min(length, temperature)
    }
    temperature -= cooling
  }
  return positions
}

function hash(text: string): number {
  let value = 0
  for (const char of text)
    value = (value * 31 + char.charCodeAt(0)) >>> 0
  return value
}
