import type { RouteRegistrar, SseStream } from '../src'
import { describe, expect, it, vi } from 'vitest'
import { createApplication, defineRoutes, encodeSseEvent, eventStream } from '../src'

function boot(routes: RouteRegistrar) {
  return createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
    },
    routes: [
      defineRoutes(routes),
    ],
  })
}

async function readChunk(reader: ReadableStreamDefaultReader<string>): Promise<string> {
  const { value } = await reader.read()
  return value ?? ''
}

describe('encodeSseEvent', () => {
  it('encodes fields and splits multi-line data', () => {
    expect(encodeSseEvent({
      event: 'note',
      id: 7,
      retry: 1500,
      data: 'a\nb\r\nc',
    }))
      .toBe('event: note\nid: 7\nretry: 1500\ndata: a\ndata: b\ndata: c\n\n')
    expect(encodeSseEvent({
      data: { n: 1n },
    })).toBe('data: {"n":"1"}\n\n')
    expect(encodeSseEvent({ data: '' })).toBe('data: \n\n')
  })

  it('rejects line breaks in event names and ids', () => {
    expect(() => encodeSseEvent({ event: 'a\nb' })).toThrow(TypeError)
    expect(() => encodeSseEvent({ id: 'a\rb' })).toThrow(TypeError)
  })
})

describe('eventStream', () => {
  it('sends an async iterable and closes when it ends', async () => {
    async function* source() {
      yield {
        event: 'progress',
        data: { percent: 50 },
      }
      yield { data: 'done' }
    }
    const response = eventStream(source(), { heartbeat: false })
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(await response.text()).toBe('event: progress\ndata: {"percent":50}\n\ndata: done\n\n')
  })

  it('keeps a callback stream open until close()', async () => {
    const response = eventStream((stream) => {
      stream.comment('hi')
      setTimeout(() => {
        stream.send({ data: 1 })
        stream.close()
        stream.send({ data: 2 })
      }, 10)
    }, {
      heartbeat: false,
      status: 201,
      headers: { 'cache-control': 'no-store' },
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe(': hi\n\ndata: 1\n\n')
  })

  it('cleans up when the client disconnects', async () => {
    const controller = new AbortController()
    const closed = vi.fn()
    let finished = false
    async function* source() {
      try {
        yield { data: 'first' }
        // 生成器的 return() 会排在当前 await 之后执行
        await new Promise(resolve => setTimeout(resolve, 20))
        yield { data: 'never' }
      }
      finally {
        finished = true
      }
    }
    const callback = eventStream((stream) => {
      stream.onClose(closed)
    }, { signal: controller.signal, heartbeat: false })
    const iterable = eventStream(source(), { signal: controller.signal, heartbeat: false })
    const reader = iterable.body!.pipeThrough(new TextDecoderStream()).getReader()
    expect(await readChunk(reader)).toBe('data: first\n\n')
    controller.abort()
    expect(closed).toHaveBeenCalledOnce()
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    await vi.waitFor(() => expect(finished).toBe(true))
    expect(await callback.text()).toBe('')
  })

  it('closes when the reader cancels', async () => {
    const closed = vi.fn()
    const response = eventStream((stream) => {
      stream.send({ data: 'x' })
      stream.onClose(closed)
    }, { heartbeat: false })
    await response.body!.cancel()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('sends heartbeats', async () => {
    vi.useFakeTimers()
    try {
      let stream!: SseStream
      const response = eventStream((s) => {
        stream = s
      }, { heartbeat: '2s' })
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
      vi.advanceTimersByTime(2000)
      expect(await readChunk(reader)).toBe(': ping\n\n')
      stream.close()
      expect(await reader.read()).toEqual({ done: true, value: undefined })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('reports source errors and closes', async () => {
    const onError = vi.fn()
    async function* source() {
      yield { data: 'a' }
      throw new Error('boom')
    }
    const response = eventStream(source(), { heartbeat: false, onError })
    expect(await response.text()).toBe('data: a\n\n')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }))
  })
})

describe('ctx.sse', () => {
  it('streams from a route without the response envelope', async () => {
    const app = await boot((r) => {
      r.get('/events', ctx => ctx.sse(async function* () {
        yield {
          event: 'greet',
          data: {
            hello: ctx.query('name'),
          },
        }
      }()))
    })
    const response = await app.request('/events?name=haze')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toBe('event: greet\ndata: {"hello":"haze"}\n\n')
  })

  it('is not buffered by cacheResponse', async () => {
    const app = await boot((r) => {
      r.get('/live', ctx => ctx.sse((stream) => {
        stream.send({ data: 'tick' })
      }, { heartbeat: false })).middleware('cacheResponse:60')
    })
    const response = await app.request('/live')
    expect(response.headers.get('x-cache')).toBeNull()
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    expect(await readChunk(reader)).toBe('data: tick\n\n')
    await reader.cancel()
  })
})
