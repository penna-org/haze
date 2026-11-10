import { describe, expect, it } from 'vitest'
import { RedisManager } from '../src'
import { redisStore } from '../src/cache/drivers/redis'

/** 最小的假客户端：只实现 clear() 用到的命令 */
function fakeNode(keys: Set<string>) {
  return {
    scans: 0,
    async scan(cursor: string, _match: string, pattern: string) {
      this.scans++
      const prefix = pattern.slice(0, -1)
      const matched = [...keys].filter(key => key.startsWith(prefix))
      // 第一页返回一个键和下一页的游标，第二页返回其余的
      return cursor === '0' && matched.length > 1
        ? [
            '1',
            matched.slice(0, 1),
          ]
        : ['0', matched]
    },
  }
}

function fakeClient(extra: Record<string, unknown>) {
  return {
    status: 'ready',
    options: { keyPrefix: 'app:' },
    on() {
      return this
    },
    once() {
      return this
    },
    duplicate() {
      return this
    },
    quit: async () => 'OK',
    disconnect() {},
    ...extra,
  }
}

describe('redis cache store clear()', () => {
  it('scans every master and deletes key by key on a Cluster', async () => {
    const a = new Set(['app:cache:1', 'app:cache:2', 'app:other'])
    const b = new Set(['app:cache:3'])
    const nodes = [
      fakeNode(a),
      fakeNode(b),
    ]
    const deleted: string[][] = []
    const cluster = fakeClient({
      nodes: (role: string) => {
        expect(role).toBe('master')
        return nodes
      },
      // 集群客户端自己的 SCAN 只会落到一个节点：不应被使用
      scan: async () => {
        throw new Error('scan on the cluster client')
      },
      // 多键 DEL 在 Cluster 上要求同一个槽
      del: async (...keys: string[]) => {
        if (keys.length > 1)
          throw new Error('CROSSSLOT Keys in request don\'t hash to the same slot')
        deleted.push(keys)
        for (const set of [a, b])
          set.delete(`app:${keys[0]}`)
        return 1
      },
    })
    const store = redisStore('cluster', { driver: 'redis', client: cluster } as never, new RedisManager())
    await store.clear('cache:')
    // keyPrefix 由客户端在 DEL 时再加上：传入的键已去掉它
    expect(deleted.flat().sort()).toEqual(['cache:1', 'cache:2', 'cache:3'])
    expect([
      ...a,
      ...b,
    ]).toEqual(['app:other'])
    expect(nodes.every(node => node.scans >= 1)).toBe(true)
  })

  it('keeps SCAN + multi-key DEL on a single node', async () => {
    const keys = new Set(['app:cache:1', 'app:cache:2', 'app:other'])
    const deleted: string[][] = []
    const single = fakeClient({
      scan: async (_cursor: string, _match: string, pattern: string) => [
        '0',
        [...keys].filter(key => key.startsWith(pattern.slice(0, -1))),
      ],
      del: async (...names: string[]) => {
        deleted.push(names)
        return names.length
      },
    })
    const store = redisStore('single', { driver: 'redis', client: single } as never, new RedisManager())
    await store.clear('cache:')
    expect(deleted).toEqual([
      ['cache:1', 'cache:2'],
    ])
  })
})
