import type { ApplicationOptions, HttpContext, NormalizedError, RouteRegistrar } from '../src'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  BusinessException,
  createApplication,
  defineInterceptor,
  defineRoutes,
  jsonReplacer,
  raw,
  ResponseFormatter,
  toJsonSafe,
} from '../src'

function boot(routes: RouteRegistrar, options: ApplicationOptions = {}) {
  return createApplication({
    mode: 'test',
    env: false,
    ...options,
    routes: [
      defineRoutes(routes),
    ],
  })
}

async function json(res: Response): Promise<any> {
  return res.json()
}

/** 团队自定义格式：{ success, result } / { success, errorCode, errorMessage } */
class TeamFormatter extends ResponseFormatter {
  override success(data: unknown) {
    return { success: true, result: data }
  }

  override error(error: NormalizedError, ctx: HttpContext) {
    return {
      success: false,
      errorCode: error.code,
      errorMessage: error.message,
      traceId: ctx.requestId,
      fields: error.errors,
    }
  }
}

const routes: RouteRegistrar = (r) => {
  r.get('/users', () => [
    { id: 1 },
  ])
  r.get('/text', () => 'plain text')
  r.get('/raw', () => raw({ legacy: true }))
  r.get('/legacy', () => ({ legacy: true })).meta({ envelope: false })
  r.post('/pay', () => {
    throw new BusinessException(10001, '余额不足')
  })
  r.post('/users', () => 'ok').validate({
    body: v.object({
      name: v.string('名称必填'),
    }),
  })
}

describe('response formatter', () => {
  it('replaces both success and error shapes globally', async () => {
    const app = await boot(routes, { responseFormatter: TeamFormatter })
    expect(await json(await app.request('/users'))).toEqual({
      success: true,
      result: [
        { id: 1 },
      ],
    })

    const pay = await app.request('/pay', {
      method: 'POST',
      headers: { 'x-request-id': 'r-1' },
    })
    expect(await json(pay)).toEqual({
      success: false,
      errorCode: 10001,
      errorMessage: '余额不足',
      traceId: 'r-1',
    })

    const invalid = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":1}',
    })
    expect(invalid.status).toBe(422)
    expect((await json(invalid)).fields).toEqual([
      { target: 'body', path: 'name', message: '名称必填' },
    ])

    const missing = await app.request('/nope')
    expect([missing.status, (await json(missing)).errorCode]).toEqual([404, 404])
  })

  it('skips formatting for raw(), envelope: false and non-data values', async () => {
    const app = await boot(routes, { responseFormatter: TeamFormatter })
    expect(await json(await app.request('/raw'))).toEqual({ legacy: true })
    expect(await json(await app.request('/legacy'))).toEqual({ legacy: true })
    expect(await (await app.request('/text')).text()).toBe('plain text')
  })

  it('lets middleware see raw handler data before formatting', async () => {
    const app = await boot(r => r.get('/items', () => [1, 2, 3]).middleware(async (_ctx, next) => {
      const data = await next() as number[]
      return data.map(n => n * 10)
    }))
    expect((await json(await app.request('/items'))).data).toEqual([10, 20, 30])
  })

  it('can be customized per value via shouldFormat', async () => {
    class OnlyArrays extends ResponseFormatter {
      override shouldFormat(value: unknown) {
        return Array.isArray(value)
      }
    }
    const app = await boot((r) => {
      r.get('/list', () => [1])
      r.get('/one', () => ({ id: 1 }))
    }, { responseFormatter: OnlyArrays })
    expect(await json(await app.request('/list'))).toEqual({
      code: 0,
      message: 'ok',
      data: [1],
    })
    expect(await json(await app.request('/one'))).toEqual({ id: 1 })
  })
})

describe('outbound interceptors', () => {
  it('receives the final response after formatting and error rendering', async () => {
    const seen: Array<[number, string]> = []
    const app = await boot(routes, {
      interceptors: [
        defineInterceptor(async (response, ctx) => {
          seen.push([response.status, await response.clone().text()])
          response.headers.set('x-trace', ctx.requestId)
        }),
      ],
    })

    const ok = await app.request('/users', {
      headers: { 'x-request-id': 'abc' },
    })
    expect(ok.headers.get('x-trace')).toBe('abc')
    expect(ok.headers.get('x-request-id')).toBe('abc')
    const failed = await app.request('/pay', { method: 'POST' })
    expect(failed.status).toBe(200)

    expect(seen).toEqual([
      [
        200,
        JSON.stringify({
          code: 0,
          message: 'ok',
          data: [
            { id: 1 },
          ],
        }),
      ],
      [
        200,
        JSON.stringify({ code: 10001, message: '余额不足', data: null }),
      ],
    ])
  })

  it('can replace the response, runs in order and can be registered from providers', async () => {
    const app = await boot(routes, {
      interceptors: {
        '/app/interceptor/1-sign.ts': {
          default: defineInterceptor(async (response) => {
            const body = await response.text()
            return new Response(body, {
              status: response.status,
              headers: {
                ...Object.fromEntries(response.headers),
                'x-signature': String(body.length),
              },
            })
          }),
        },
      },
      providers: [
        {
          boot: app => void app.intercept(response => void response.headers.set('x-from-provider', '1')),
        },
      ],
    })
    const res = await app.request('/text')
    expect(res.headers.get('x-signature')).toBe('10')
    expect(res.headers.get('x-from-provider')).toBe('1')
    expect(await res.text()).toBe('plain text')
  })
})

describe('bigint values', () => {
  it('serializes BigInt as strings in formatted, raw and unformatted responses', async () => {
    const app = await boot((r) => {
      r.get('/formatted', () => ({
        id: 9007199254740993n,
        nested: [
          { id: 1n },
        ],
        date: new Date(0),
      }))
      r.get('/raw', () => raw({ id: 2n }))
      r.get('/bare', () => [3n]).meta({ envelope: false })
      r.get('/scalar', () => 4n)
    })
    expect(await (await app.request('/formatted')).json()).toEqual({
      code: 0,
      message: 'ok',
      data: {
        id: '9007199254740993',
        nested: [
          { id: '1' },
        ],
        date: '1970-01-01T00:00:00.000Z',
      },
    })
    expect(await (await app.request('/raw')).json()).toEqual({ id: '2' })
    expect(await (await app.request('/bare')).json()).toEqual(['3'])
    expect(await (await app.request('/scalar')).json()).toMatchObject({ data: '4' })
  })

  it('keeps references when there is nothing to convert', () => {
    const value = {
      a: [
        1,
        { b: 'x' },
      ],
    }
    expect(toJsonSafe(value)).toBe(value)
    const converted = toJsonSafe({
      a: [
        1,
        { b: 2n },
      ],
      c: 'x',
    })
    expect(converted).toEqual({
      a: [
        1,
        { b: '2' },
      ],
      c: 'x',
    })
    expect(JSON.stringify({ id: 5n }, jsonReplacer)).toBe('{"id":"5"}')
  })
})
