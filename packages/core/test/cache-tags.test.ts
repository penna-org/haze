import type { Tenant } from '../src/tenancy/config'
import { describe, expect, it } from 'vitest'
import { Cache, CacheManager, TaggedCache } from '../src'
import { Tenancy } from '../src/tenancy/facade'
import { bootCache, cacheDrivers, memoryDriver, redisUrl, useKvBinding } from './support/cache-drivers'

useKvBinding()

const tenants: Record<string, Tenant> = {
  acme: { id: 'acme' },
  globex: { id: 'globex' },
}

describe.each(cacheDrivers)('tagged cache ($name)', (driver) => {
  it('reads and writes under a tag and clears it', async () => {
    await bootCache(driver)
    const users = Cache.tag('user')
    expect(users).toBeInstanceOf(TaggedCache)
    await users.set('user:1', { name: 'Ada' }, '10m')
    await users.set('user:2', { name: 'Bob' })
    expect(await users.get('user:1')).toEqual({ name: 'Ada' })
    expect(await users.has('user:2')).toBe(true)
    expect(await users.many(['user:1', 'user:2', 'user:3'])).toEqual({
      'user:1': { name: 'Ada' },
      'user:2': { name: 'Bob' },
      'user:3': undefined,
    })
    // 不带标签读取是另一个命名空间
    expect(await Cache.get('user:1')).toBeUndefined()
    await Cache.set('user:1', 'untagged')

    await users.clear()
    expect(await users.get('user:1')).toBeUndefined()
    expect(await users.has('user:2')).toBe(false)
    expect(await Cache.get('user:1')).toBe('untagged')
    // 清除后可以继续写入
    await users.set('user:1', 'again')
    expect(await Cache.tag('user').get('user:1')).toBe('again')
  })

  it('supports multiple tags, in any order, and clears across tag sets', async () => {
    await bootCache(driver)
    await Cache.tag(['user', 'post']).set('feed', [1, 2])
    await Cache.tag('post').set('latest', 'p1')
    await Cache.tag('user').set('count', 3)
    // 标签顺序无关
    expect(await Cache.tag(['post', 'user']).get('feed')).toEqual([1, 2])
    expect(await Cache.tag('user').tag('post').get('feed')).toEqual([1, 2])
    // 读取必须使用写入时的同一组标签
    expect(await Cache.tag('user').get('feed')).toBeUndefined()

    await Cache.tag('user').clear()
    expect(await Cache.tag(['user', 'post']).get('feed')).toBeUndefined()
    expect(await Cache.tag('user').get('count')).toBeUndefined()
    // 只带 post 的值不受影响
    expect(await Cache.tag('post').get('latest')).toBe('p1')
  })

  it('remembers, pulls, deletes, counts and pushes under tags', async () => {
    await bootCache(driver)
    const tagged = Cache.tag(['stats'])
    let calls = 0
    expect(await tagged.remember('total', '1m', () => ++calls)).toBe(1)
    expect(await tagged.remember('total', '1m', () => ++calls)).toBe(1)
    expect(await tagged.rememberForever('forever', () => 'v')).toBe('v')
    expect(await tagged.pull('total')).toBe(1)
    expect(await tagged.has('total')).toBe(false)

    expect(await tagged.inc('hits')).toBe(1)
    expect(await tagged.inc('hits', 2)).toBe(3)
    expect(await tagged.dec('hits')).toBe(2)
    await tagged.push('events', 'a')
    await tagged.push('events', 'b')
    expect(await tagged.get('events')).toEqual(['a', 'b'])
    expect(await tagged.add('once', 1)).toBe(true)
    expect(await tagged.add('once', 2)).toBe(false)
    expect(await tagged.delete('once')).toBe(true)
    expect(await tagged.ttl('forever')).toBeUndefined()

    await tagged.clear()
    for (const key of ['forever', 'hits', 'events'])
      expect(await tagged.get(key)).toBeUndefined()
  })

  it('respects the store prefix', async () => {
    const app = await bootCache(driver)
    await Cache.tag('user').set('k', 'mine')
    // 同一服务中前缀不同的应用有自己的标签版本
    const foreign = new CacheManager(app.config)
    Object.defineProperty(foreign, 'config', {
      value: {
        ...app.make(CacheManager).config,
        prefix: `foreign:${crypto.randomUUID()}:`,
      },
    })
    expect(await foreign.store().tag('user').get('k')).toBeUndefined()
    await foreign.store().tag('user').set('k', 'theirs')
    await foreign.store().tag('user').clear()
    expect(await Cache.tag('user').get('k')).toBe('mine')
    // flush 清除本前缀下的值与标签版本
    await Cache.flush()
    expect(await Cache.tag('user').get('k')).toBeUndefined()
  })
})

describe('tagged cache isolation', () => {
  it('keeps tags per tenant', async () => {
    await bootCache(memoryDriver, {
      tenancy: {
        find: (key: string) => tenants[key],
      },
    })
    await Tenancy.run(tenants.acme!, () => Cache.tag('user').set('k', 'acme'))
    await Tenancy.run(tenants.globex!, () => Cache.tag('user').set('k', 'globex'))
    expect(await Tenancy.run(tenants.globex!, () => Cache.tag('user').get('k'))).toBe('globex')
    // 一个租户清除标签不影响另一个租户
    await Tenancy.run(tenants.acme!, () => Cache.tag('user').clear())
    expect(await Tenancy.run(tenants.acme!, () => Cache.tag('user').get('k'))).toBeUndefined()
    expect(await Tenancy.run(tenants.globex!, () => Cache.tag('user').get('k'))).toBe('globex')
    // 版本键与值都在租户前缀下
    const keys = [
      ...(await Cache.store().handler() as Map<string, unknown>).keys(),
    ]
    expect(keys.some(key => key.includes('tenant:globex:tag:user:version'))).toBe(true)
    expect(keys.some(key => key.includes('tenant:globex:tagged:'))).toBe(true)
  })

  it('works on stores reached through Cache.store()', async () => {
    await bootCache(memoryDriver)
    await Cache.store('other').tag('user').set('k', 1)
    expect(await Cache.store('other').tag('user').get('k')).toBe(1)
    expect(await Cache.tag('user').get('k')).toBeUndefined()
    expect(() => Cache.tag([])).toThrow('at least one tag')
  })

  it.runIf(redisUrl)('deletes tagged keys on redis to free memory', async () => {
    await bootCache({
      name: 'redis',
      config: { driver: 'redis', url: redisUrl },
      atomic: true,
      structures: true,
    })
    const repository = Cache.store()
    const client = await repository.handler() as any
    const both = Cache.tag(['user', 'post'])
    await both.set('a', 1, 60)
    await both.set('b', 2)
    const keyA = (await (both as any).resolve(['a']))[0]
    expect(await client.get(keyA)).toBe('1')
    expect(await client.zcard(repository.key('tag:user:keys'))).toBe(2)
    expect(await client.zcard(repository.key('tag:post:keys'))).toBe(2)

    await Cache.tag('user').clear()
    // 值与 user 的索引被删除；post 的索引留下的成员在它清除或过期时处理
    expect(await client.get(keyA)).toBeNull()
    expect(await client.exists(repository.key('tag:user:keys'))).toBe(0)
    await Cache.tag('post').clear()
    expect(await client.exists(repository.key('tag:post:keys'))).toBe(0)
    await Cache.flush()
  })
})
