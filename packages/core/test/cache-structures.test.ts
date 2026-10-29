import { describe, expect, it } from 'vitest'
import { Cache, CacheHash, isRedisCache, RedisCacheRepository } from '../src'
import { Tenancy } from '../src/tenancy/facade'
import { bootCache, cacheDrivers, memoryDriver, sleep, structureDrivers, useKvBinding } from './support/cache-drivers'

useKvBinding()

describe.each(structureDrivers)('cache data structures ($name)', (driver) => {
  it('hash', async () => {
    await bootCache(driver)
    const redis = Cache.redis()
    const user = redis.hash<unknown>('user:1')
    expect(user).toBeInstanceOf(CacheHash)
    await user.set('name', 'Ada')
    await user.set({
      visits: 0,
      joined: new Date(0),
      roles: ['admin'],
    })
    expect(await user.get('name')).toBe('Ada')
    expect(await user.get('joined')).toEqual(new Date(0))
    expect(await user.get('missing')).toBeUndefined()
    expect(await user.has('roles')).toBe(true)
    expect(await user.increment('visits')).toBe(1)
    expect(await user.increment('visits', 2.5)).toBe(3.5)
    expect(await user.decrement('visits', 0.5)).toBe(3)
    expect(await user.all()).toEqual({
      name: 'Ada',
      visits: 3,
      joined: new Date(0),
      roles: ['admin'],
    })
    expect((await user.keys()).sort()).toEqual(['joined', 'name', 'roles', 'visits'])
    expect(await user.values()).toHaveLength(4)
    expect(await user.length()).toBe(4)
    expect(await user.delete('roles', 'missing')).toBe(1)
    expect(await user.length()).toBe(3)
    expect(await user.exists()).toBe(true)
    expect(await user.drop()).toBe(true)
    expect(await user.exists()).toBe(false)
    expect(await user.all()).toEqual({})
  })

  it('list', async () => {
    await bootCache(driver)
    const list = Cache.redis().list<string | { id: number }>('queue')
    expect(await list.push('a', 'b')).toBe(2)
    expect(await list.unshift('y', 'z')).toBe(4)
    expect(await list.push({ id: 1 })).toBe(5)
    expect(await list.range()).toEqual([
      'y',
      'z',
      'a',
      'b',
      { id: 1 },
    ])
    expect(await list.range(1, -2)).toEqual(['z', 'a', 'b'])
    expect(await list.pop()).toEqual({ id: 1 })
    expect(await list.shift()).toBe('y')
    expect(await list.length()).toBe(3)
    await list.push('a', 'a')
    expect(await list.remove('a', 1)).toBe(1)
    expect(await list.all()).toEqual(['z', 'b', 'a', 'a'])
    expect(await list.remove('a')).toBe(2)
    await list.trim(0, 0)
    expect(await list.all()).toEqual(['z'])
    expect(await list.pop()).toBe('z')
    expect(await list.pop()).toBeUndefined()
    expect(await list.exists()).toBe(false)
  })

  it('set', async () => {
    await bootCache(driver)
    const redis = Cache.redis()
    const tags = redis.set<string>('tags')
    expect(await tags.add('a', 'b', 'a')).toBe(2)
    expect(await tags.add('c')).toBe(1)
    expect(await tags.has('a')).toBe(true)
    expect(await tags.has('x')).toBe(false)
    expect((await tags.members()).sort()).toEqual(['a', 'b', 'c'])
    expect(await tags.size()).toBe(3)
    expect(await tags.remove('c', 'x')).toBe(1)
    expect(['a', 'b']).toContain(await tags.random())
    expect((await tags.random(5)).sort()).toEqual(['a', 'b'])
    const popped = await tags.pop()
    expect(['a', 'b']).toContain(popped)
    expect(await tags.size()).toBe(1)
    expect(await tags.pop(3)).toHaveLength(1)
    expect(await tags.pop()).toBeUndefined()
    // set(key, value) 仍然是写缓存
    await redis.set('plain', 1)
    expect(await redis.get('plain')).toBe(1)
  })

  it('sorted set', async () => {
    await bootCache(driver)
    const scores = Cache.redis().sortedSet('scores')
    expect(await scores.add('ada', 42)).toBe(1)
    expect(await scores.add({ bob: 7, cy: 19.5 })).toBe(2)
    expect(await scores.add([
      ['dee', -3],
    ])).toBe(1)
    expect(await scores.increment('bob', 3)).toBe(10)
    expect(await scores.score('cy')).toBe(19.5)
    expect(await scores.score('nobody')).toBeUndefined()
    expect(await scores.rank('ada')).toBe(3)
    expect(await scores.rank('ada', { reverse: true })).toBe(0)
    expect(await scores.rank('nobody')).toBeUndefined()
    expect(await scores.range()).toEqual(['dee', 'bob', 'cy', 'ada'])
    expect(await scores.range(0, 1, { reverse: true })).toEqual(['ada', 'cy'])
    expect(await scores.range(0, 0, { withScores: true })).toEqual([
      { member: 'dee', score: -3 },
    ])
    expect(await scores.top(2)).toEqual([
      { member: 'ada', score: 42 },
      { member: 'cy', score: 19.5 },
    ])
    expect(await scores.rangeByScore(0, 20)).toEqual(['bob', 'cy'])
    expect(await scores.rangeByScore('(10', '+inf')).toEqual(['cy', 'ada'])
    expect(await scores.rangeByScore('-inf', Number.POSITIVE_INFINITY, {
      reverse: true,
      limit: { offset: 1, count: 2 },
    })).toEqual(['cy', 'bob'])
    expect(await scores.rangeByScore(0, 50, { withScores: true })).toEqual([
      { member: 'bob', score: 10 },
      { member: 'cy', score: 19.5 },
      { member: 'ada', score: 42 },
    ])
    expect(await scores.remove('dee', 'nobody')).toBe(1)
    expect(await scores.size()).toBe(3)
    // zset 为同一个结构的别名；成员可以是对象
    const objects = Cache.redis().zset<{ id: number }>('objects')
    await objects.add({ id: 1 }, 5)
    await objects.add([
      [
        { id: 2 },
        6,
      ],
    ])
    expect(await objects.top(1)).toEqual([
      {
        member: { id: 2 },
        score: 6,
      },
    ])
    expect(await objects.score({ id: 1 })).toBe(5)
  })

  it('applies ttls to the whole key', async () => {
    await bootCache(driver)
    const redis = Cache.redis()
    const hash = redis.hash('session')
    await hash.set('a', 1, '10m')
    expect(await hash.ttl()).toBeGreaterThan(590)
    await hash.set({ b: 2 }, 60)
    expect(await hash.ttl()).toBeLessThanOrEqual(60)
    expect(await hash.expire()).toBe(true)
    expect(await hash.ttl()).toBeUndefined()

    // 句柄上的 ttl 在每次写入后应用
    const recent = redis.list('recent', 120)
    await recent.push('x')
    expect(await recent.ttl()).toBeGreaterThan(110)
    const online = redis.setOf('online', 30)
    await online.add('u1')
    expect(await online.ttl()).toBeLessThanOrEqual(30)
    await redis.zset('board').add('a', 1, 45)
    expect(await redis.zset('board').ttl()).toBeLessThanOrEqual(45)
    expect(await redis.zset('missing').ttl()).toBeNull()
    expect(await redis.zset('missing').expire(10)).toBe(false)

    const short = redis.set('short')
    await short.add('v')
    await short.expire(1)
    await sleep(1100)
    expect(await short.exists()).toBe(false)
  })

  it('uses the cache prefix and refuses wrong types', async () => {
    await bootCache(driver)
    const redis = Cache.redis()
    await redis.list('items').push(1)
    expect(redis.list('items').key).toBe(redis.key('items'))
    // 与 Redis 一样，按普通值读取数据结构会报 WRONGTYPE
    await expect(Cache.has('items')).rejects.toThrow('WRONGTYPE')
    await expect(redis.get('items')).rejects.toThrow('WRONGTYPE')
    await expect(redis.hash('items').get('f')).rejects.toThrow('WRONGTYPE')
    // flush 同样清除数据结构
    await Cache.flush()
    expect(await redis.list('items').exists()).toBe(false)
  })
})

describe('cache data structures wiring', () => {
  it('returns RedisCacheRepository for memory and redis stores only', async () => {
    await bootCache(memoryDriver, {
      cache: {
        stores: {
          kv: { driver: 'kv', binding: 'CACHE' },
        },
      },
    })
    expect(Cache.store()).toBeInstanceOf(RedisCacheRepository)
    expect(isRedisCache(Cache.store())).toBe(true)
    expect(isRedisCache(Cache.store('kv'))).toBe(false)
    expect(() => Cache.redis('kv')).toThrow('is not a Redis store')
    expect(Cache.redis('other')).toBe(Cache.store('other'))
  })

  it('isolates structures per tenant', async () => {
    const tenants = {
      acme: { id: 'acme' },
      globex: { id: 'globex' },
    }
    await bootCache(memoryDriver, {
      tenancy: {
        find: (key: string) => tenants[key as keyof typeof tenants],
      },
    })
    await Tenancy.run(tenants.acme, () => Cache.redis().hash('settings').set('theme', 'dark'))
    expect(await Tenancy.run(tenants.globex, () => Cache.redis().hash('settings').get('theme'))).toBeUndefined()
    expect(await Tenancy.run(tenants.acme, () => Cache.redis().hash('settings').get('theme'))).toBe('dark')
    const keys = [
      ...(await Cache.store().handler() as Map<string, unknown>).keys(),
    ]
    expect(keys.some(key => key.endsWith('tenant:acme:settings'))).toBe(true)
  })

  it.runIf(cacheDrivers.some(driver => driver.name === 'redis'))('stores structures as native Redis types', async () => {
    const driver = cacheDrivers.find(driver => driver.name === 'redis-connection')!
    await bootCache(driver)
    const redis = Cache.redis()
    await redis.hash('h').set({ n: 1, s: 'x' })
    await redis.zset('z').add('ada', 42)
    const client = await redis.handler()
    // 带 keyPrefix 的命名连接：ioredis 自动在键前加 keyPrefix
    expect(client.options?.keyPrefix).toBe('haze-test-kp:')
    expect(await client.type(redis.key('h'))).toBe('hash')
    expect(await client.hgetall(redis.key('h'))).toEqual({ n: '1', s: '"x"' })
    expect(await client.zscore(redis.key('z'), '"ada"')).toBe('42')
    await Cache.flush()
    expect(await client.exists(redis.key('h'))).toBe(0)
  })
})
