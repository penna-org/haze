import type { CacheSerializer } from '../src'
import { describe, expect, it } from 'vitest'
import { Cache, jsonSerializer, typedSerializer } from '../src'
import { bootCache, cacheDrivers, memoryDriver, useKvBinding } from './support/cache-drivers'

useKvBinding()

const date = new Date('2026-10-28T08:00:00.000Z')

/** 覆盖全部可还原类型的值 */
const rich = {
  at: date,
  id: 9007199254740993n,
  roles: new Set(['admin', 'editor']),
  scores: new Map<unknown, unknown>([
    ['ada', 42],
    [
      1,
      {
        nested: new Date(0),
      },
    ],
  ]),
  nested: {
    list: [
      1,
      undefined,
      new Date(1000),
      [2n],
    ],
    maybe: undefined,
    plain: { a: 'b', n: null },
  },
}

describe('typed serializer', () => {
  it('round-trips Date, BigInt, Map, Set and undefined, nested', () => {
    const raw = typedSerializer.serialize(rich)
    // 仍是合法的 JSON，普通值保持原样
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(JSON.parse(raw).nested.plain).toEqual({ a: 'b', n: null })
    const back = typedSerializer.deserialize(raw) as typeof rich
    expect(back).toEqual(rich)
    expect(back.at).toBeInstanceOf(Date)
    expect(back.id).toBe(9007199254740993n)
    expect(back.roles).toBeInstanceOf(Set)
    expect(back.scores.get(1)).toEqual({
      nested: new Date(0),
    })
    expect(back.nested.list).toHaveLength(4)
    expect(back.nested.list[1]).toBeUndefined()
    expect(1 in back.nested.list).toBe(true)
    expect('maybe' in back.nested).toBe(true)
  })

  it('emits compact tags only for the special types', () => {
    expect(typedSerializer.serialize({
      a: 1,
      b: ['x'],
      c: null,
    })).toBe('{"a":1,"b":["x"],"c":null}')
    expect(typedSerializer.serialize(date)).toBe('{"$t":"Date","v":"2026-10-28T08:00:00.000Z"}')
    expect(typedSerializer.serialize(5n)).toBe('{"$t":"BigInt","v":"5"}')
    expect(typedSerializer.serialize(new Set([1]))).toBe('{"$t":"Set","v":[1]}')
    expect(typedSerializer.serialize(new Map([
      ['k', 1],
    ]))).toBe('{"$t":"Map","v":[["k",1]]}')
    expect(typedSerializer.serialize([undefined])).toBe('[{"$t":"undefined"}]')
    // 顶层的 undefined 与原来一样存为 null
    expect(typedSerializer.serialize(undefined)).toBe('null')
  })

  it('serializes objects through toJSON (models) and escapes user keys named $t', () => {
    class Model {
      constructor(readonly id: number, readonly secret: string, readonly createdAt: Date) {}
      toJSON() {
        return { id: this.id, createdAt: this.createdAt }
      }
    }
    const back = typedSerializer.deserialize(typedSerializer.serialize({
      user: new Model(1, 'hidden', date),
    }))
    expect(back).toEqual({
      user: { id: 1, createdAt: date },
    })

    const tricky = {
      $t: 'Date',
      v: 'not a date',
      other: [
        new Date(5),
      ],
    }
    const raw = typedSerializer.serialize(tricky)
    expect(typedSerializer.deserialize(raw)).toEqual(tricky)
    expect(typedSerializer.deserialize(typedSerializer.serialize({ $t: 'x', missing: undefined }))).toEqual({ $t: 'x', missing: undefined })
  })

  it('reads values written by the plain JSON serializer', () => {
    const legacy = JSON.stringify({
      at: date,
      id: '123',
      list: [1, null],
      nested: { ok: true },
    })
    expect(typedSerializer.deserialize(legacy)).toEqual({
      at: date.toISOString(),
      id: '123',
      list: [1, null],
      nested: { ok: true },
    })
    expect(typedSerializer.deserialize('"text"')).toBe('text')
    expect(typedSerializer.deserialize('42')).toBe(42)
    expect(typedSerializer.deserialize('null')).toBeNull()
  })

  it('keeps the json serializer as plain JSON with BigInt as strings', () => {
    expect(jsonSerializer.serialize({ at: date, id: 5n })).toBe('{"at":"2026-10-28T08:00:00.000Z","id":"5"}')
    expect(jsonSerializer.deserialize('{"at":"x"}')).toEqual({ at: 'x' })
    expect(jsonSerializer.element!(5n)).toBe('"5"')
    expect(typedSerializer.element!(date)).toBe('{"$t":"Date","v":"2026-10-28T08:00:00.000Z"}')
  })

  it('handles invalid dates and refuses circular values like JSON', () => {
    const back = typedSerializer.deserialize(typedSerializer.serialize({
      when: new Date(Number.NaN),
    })) as { when: Date }
    expect(back.when).toBeInstanceOf(Date)
    expect(Number.isNaN(back.when.getTime())).toBe(true)
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(() => typedSerializer.serialize(loop)).toThrow(TypeError)
  })
})

describe.each(cacheDrivers)('serialization through the store ($name)', (driver) => {
  it('restores rich values by default', async () => {
    await bootCache(driver)
    await Cache.set('rich', rich)
    expect(await Cache.get('rich')).toEqual(rich)
    await Cache.push('dates', date)
    await Cache.push('dates', 7n)
    expect(await Cache.get('dates')).toEqual([date, 7n])
  })

  it('reads legacy plain JSON values', async () => {
    await bootCache(driver)
    const repository = Cache.store()
    await repository.store.set(repository.key('legacy'), JSON.stringify({ name: 'Ada', at: date }))
    expect(await Cache.get('legacy')).toEqual({
      name: 'Ada',
      at: date.toISOString(),
    })
  })
})

describe('serializer configuration', () => {
  it('uses the global serializer, overridden per store', async () => {
    const calls: string[] = []
    const custom: CacheSerializer = {
      serialize: (value) => {
        calls.push('serialize')
        return `custom:${JSON.stringify(value)}`
      },
      deserialize: (raw) => {
        calls.push('deserialize')
        return JSON.parse(raw.slice('custom:'.length))
      },
    }
    await bootCache(memoryDriver, {
      cache: {
        serializer: 'json',
        stores: {
          typed: { driver: 'memory', serializer: 'typed' },
          custom: { driver: 'memory', serializer: custom },
        },
      },
    })
    await Cache.set('d', date)
    expect(await Cache.get('d')).toBe(date.toISOString())
    await Cache.store('typed').set('d', date)
    expect(await Cache.store('typed').get('d')).toEqual(date)

    const store = Cache.store('custom')
    await store.set('k', { a: 1 })
    expect(await store.store.get(store.key('k'))).toBe('custom:{"a":1}')
    expect(await store.get('k')).toEqual({ a: 1 })
    // 自定义序列化器没有 element()：push 退回读后写
    await store.push('list', 1)
    await store.push('list', 2)
    expect(await store.get('list')).toEqual([1, 2])
    expect(calls).toContain('deserialize')
  })

  it('keeps increments and locks as raw numbers and strings', async () => {
    await bootCache(memoryDriver)
    const repository = Cache.store()
    await Cache.increment('n', 5)
    expect(await repository.store.get(repository.key('n'))).toBe('5')
    const lock = Cache.lock('job', 10)
    await lock.get()
    expect(await repository.store.get(repository.key('lock:job'))).toBe(lock.owner)
  })
})
