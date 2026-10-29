import type { TelemetryEvents } from '../src'
import { describe, expect, it } from 'vitest'
import { Cache, cache, CacheManager, CacheRepository, onTelemetry, Redis } from '../src'
import { bootCache, cacheDrivers, memoryDriver, sleep, useKvBinding } from './support/cache-drivers'

useKvBinding()

describe.each(cacheDrivers)('cache API ($name)', (driver) => {
  it('supports the ThinkPHP and PSR-16 names next to the original ones', async () => {
    await bootCache(driver)
    await Cache.setMultiple({ a: 1, b: 2, c: 3 }, '1m')
    expect(await Cache.getMultiple(['a', 'b', 'missing'])).toEqual({ a: 1, b: 2, missing: undefined })

    expect(await Cache.delete('a')).toBe(true)
    expect(await Cache.delete('a')).toBe(false)
    expect(await Cache.deleteMany(['b', 'missing'])).toBe(1)
    expect(await Cache.deleteMultiple(['c'])).toBe(1)
    expect(await Cache.has('c')).toBe(false)

    expect(await Cache.inc('n')).toBe(1)
    expect(await Cache.inc('n', 4)).toBe(5)
    expect(await Cache.dec('n', 2)).toBe(3)
    expect(await Cache.dec('n')).toBe(2)

    await Cache.set('x', 'y')
    await Cache.clear()
    expect(await Cache.get('x')).toBeUndefined()
  })

  it('pushes to array items, creating them when missing', async () => {
    await bootCache(driver)
    await Cache.push('log', 'first')
    await Cache.push('log', { at: 2 })
    await Cache.push('log', [3])
    expect(await Cache.get('log')).toEqual([
      'first',
      { at: 2 },
      [3],
    ])

    // 空数组也可以追加；get 读到的是普通数组
    await Cache.set('empty', [])
    await Cache.push('empty', 1)
    expect(await Cache.get('empty')).toEqual([1])

    await Cache.set('scalar', 'text')
    await expect(Cache.push('scalar', 1)).rejects.toThrow('is not an array')
    await Cache.set('object', { a: 1 })
    await expect(Cache.push('object', 1)).rejects.toThrow(TypeError)
  })

  it('keeps the ttl on push unless one is given', async () => {
    await bootCache(driver)
    await Cache.set('timed', [1], 120)
    await Cache.push('timed', 2)
    const kept = await Cache.ttl('timed')
    expect(kept).toBeGreaterThan(100)
    expect(kept).toBeLessThanOrEqual(120)
    await Cache.push('timed', 3, 600)
    expect(await Cache.ttl('timed')).toBeGreaterThan(500)
    expect(await Cache.get('timed')).toEqual([1, 2, 3])

    await Cache.push('fresh', 'a')
    expect(await Cache.ttl('fresh')).toBeUndefined()
  })

  it.runIf(driver.atomic)('pushes atomically under concurrency', async () => {
    await bootCache(driver)
    await Promise.all(Array.from({ length: 50 }, (_, index) => Cache.push('concurrent', index)))
    const items = await Cache.get<number[]>('concurrent')
    expect(items).toHaveLength(50)
    expect([...items!].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, index) => index))
  })

  it('reads and changes the remaining ttl without rewriting the value', async () => {
    await bootCache(driver)
    await Cache.set('timed', { v: 1 }, 120)
    const ttl = await Cache.ttl('timed')
    expect(ttl).toBeGreaterThan(110)
    expect(ttl).toBeLessThanOrEqual(120)
    await Cache.set('forever', 1)
    expect(await Cache.ttl('forever')).toBeUndefined()
    expect(await Cache.ttl('missing')).toBeNull()

    expect(await Cache.touch('timed', '10m')).toBe(true)
    expect(await Cache.ttl('timed')).toBeGreaterThan(590)
    expect(await Cache.get('timed')).toEqual({ v: 1 })
    // 省略 ttl：改为永久；expire 为同一个方法
    expect(await Cache.expire('timed')).toBe(true)
    expect(await Cache.ttl('timed')).toBeUndefined()
    expect(await Cache.touch('forever', 300)).toBe(true)
    expect(await Cache.ttl('forever')).toBeGreaterThan(290)
    expect(await Cache.touch('missing', 60)).toBe(false)
    expect(await Cache.has('missing')).toBe(false)

    // 自增的计数同样可以读取与修改有效期
    await Cache.increment('hits', 1, 90)
    expect(await Cache.ttl('hits')).toBeGreaterThan(80)
  })

  it.runIf(driver.name !== 'kv')('expires items after touch shortens their ttl', async () => {
    await bootCache(driver)
    await Cache.set('soon', 'v', 60)
    await Cache.touch('soon', 1)
    await sleep(1100)
    expect(await Cache.get('soon')).toBeUndefined()
  })

  it('exposes the underlying client through handler()', async () => {
    await bootCache(driver)
    await Cache.set('raw', { ok: true })
    const repository = Cache.store()
    const handler = await Cache.handler() as any
    switch (driver.config.driver) {
      case 'memory':
        expect(handler).toBeInstanceOf(Map)
        expect(handler.get(repository.key('raw')).value).toBe('{"ok":true}')
        break
      case 'redis':
        // M29 的共享连接（与 Redis 门面同一个 ioredis 实例）
        expect(await handler.get(repository.key('raw'))).toBe('{"ok":true}')
        expect(handler).toBe(await repository.handler())
        if (driver.name === 'redis-connection')
          expect(handler).toBe(await Redis.client('cache'))
        break
      case 'upstash':
        expect(await handler.get(repository.key('raw'))).toBe('{"ok":true}')
        break
      case 'kv':
        expect(await handler.get(repository.key('raw'))).toBe('{"ok":true}')
        break
    }
  })

  it('offers the cache() helper', async () => {
    const app = await bootCache(driver)
    expect(cache()).toBe(app.make(CacheManager).store())
    expect(cache()).toBeInstanceOf(CacheRepository)
    expect(await cache('greeting')).toBeUndefined()
    await cache('greeting', { text: 'hi' }, '10m')
    expect(await cache<{ text: string }>('greeting')).toEqual({ text: 'hi' })
    expect(await Cache.ttl('greeting')).toBeGreaterThan(590)
    expect(await cache('greeting', null)).toBe(true)
    expect(await cache('greeting')).toBeUndefined()
    // 写入 undefined 仍是写入（存为 null），只有 null 表示删除
    await cache('nothing', undefined)
    expect(await Cache.get('nothing')).toBeNull()
  })
})

describe('cache API wiring', () => {
  it('reports the new operations to telemetry', async () => {
    await bootCache(memoryDriver)
    const seen: Array<TelemetryEvents['cache']> = []
    const stop = onTelemetry((kind, data) => {
      if (kind === 'cache')
        seen.push(data as TelemetryEvents['cache'])
    })
    try {
      await Cache.push('list', 1)
      await Cache.ttl('list')
      await Cache.touch('list', 60)
      await Cache.inc('n')
      await Cache.delete('list')
      await Cache.tag('t').set('k', 1)
      await Cache.tag('t').clear()
      await Cache.redis().hash('h').set('f', 1)
    }
    finally {
      stop()
    }
    expect(seen.map(event => [event.operation, event.key, event.command])).toEqual([
      ['push', 'list', undefined],
      ['ttl', 'list', undefined],
      ['touch', 'list', undefined],
      ['increment', 'n', undefined],
      ['forget', 'list', undefined],
      ['set', 'k', undefined],
      ['flush', 'tag:t', undefined],
      ['command', 'h', 'hset'],
    ])
  })

  it('falls back to a rewrite for touch and refuses ttl on stores without them', async () => {
    await bootCache(memoryDriver)
    const base = Cache.store().store
    const writes: Array<number | undefined> = []
    const custom = new CacheRepository('custom', {
      ...base,
      ttl: undefined,
      touch: undefined,
      push: undefined,
      handler: undefined,
      set: async (key, value, ttl) => {
        writes.push(ttl)
        await base.set(key, value, ttl)
      },
    }, 'custom:')
    await custom.set('k', [1])
    expect(await custom.touch('k', 30)).toBe(true)
    expect(writes).toEqual([undefined, 30])
    await expect(custom.ttl('k')).rejects.toThrow('does not support ttl()')
    await expect(custom.handler()).rejects.toThrow('does not expose a handler')
    // 没有原生 push 时读后写
    await custom.push('k', 2)
    expect(await custom.get('k')).toEqual([1, 2])
  })
})
