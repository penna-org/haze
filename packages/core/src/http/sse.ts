import { jsonReplacer, parseDuration } from '../utils'

/** 一条 Server-Sent Event */
export interface SseEvent {
  /** 事件名（`event:`），省略时客户端按 `message` 处理 */
  event?: string
  /** 字符串原样发送，其他值 JSON 序列化（BigInt 输出为字符串）；多行拆成多条 `data:` */
  data?: unknown
  id?: string | number
  /** 客户端断线后重连的间隔（毫秒） */
  retry?: number
}

export interface SseStream {
  send: (event: SseEvent) => void
  /** 注释行（`: text`），客户端会忽略，可用于保活 */
  comment: (text: string) => void
  /** 结束响应；客户端断开时也会自动关闭 */
  close: () => void
  readonly closed: boolean
  /** 流关闭时中止，可传给上游 `fetch` / 循环判断 */
  readonly signal: AbortSignal
  /** 流关闭时调用（客户端断开、`close()` 或出错），用于退订、清理计时器 */
  onClose: (hook: () => void) => void
}

/**
 * - 函数：连接保持打开，直到调用 `stream.close()` 或客户端断开
 * - 异步可迭代对象：逐条发送，迭代结束即关闭；客户端断开时调用迭代器的 `return()`
 */
export type SseSource = ((stream: SseStream) => void | Promise<void>) | AsyncIterable<SseEvent>

export interface SseOptions {
  /** `: ping` 心跳间隔，`'15s'` / 秒数，`false` 关闭。默认 15 秒 */
  heartbeat?: string | number | false
  /** 客户端断开信号（`ctx.sse()` 自动使用 `ctx.req.signal`） */
  signal?: AbortSignal
  status?: number
  /** 追加或覆盖默认响应头 */
  headers?: ConstructorParameters<typeof Headers>[0]
  /** 源函数抛错或迭代出错时调用，随后关闭流 */
  onError?: (error: unknown) => void
}

const NEWLINE = /\r\n|\r|\n/

/** 计时器不阻止进程退出（Node） */
function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.()
}

function assertField(name: string, value: string): string {
  if (NEWLINE.test(value))
    throw new TypeError(`SSE ${name} must not contain line breaks`)
  return value
}

/** 编码一条事件（以空行结尾） */
export function encodeSseEvent(event: SseEvent): string {
  let text = ''
  if (event.event !== undefined)
    text += `event: ${assertField('event', event.event)}\n`
  if (event.id !== undefined)
    text += `id: ${assertField('id', String(event.id))}\n`
  if (event.retry !== undefined)
    text += `retry: ${Math.max(0, Math.floor(event.retry))}\n`
  if (event.data !== undefined) {
    const data = typeof event.data === 'string'
      ? event.data
      : JSON.stringify(event.data, jsonReplacer)
    for (const line of data.split(NEWLINE))
      text += `data: ${line}\n`
  }
  return `${text}\n`
}

function encodeComment(text: string): string {
  return `${text.split(NEWLINE).map(line => `: ${line}\n`).join('')}\n`
}

/**
 * 创建 `text/event-stream` 响应：心跳、断开清理、禁用代理缓冲都已处理。
 * 控制器中通常用 `ctx.sse()`：
 *
 * ```ts
 * return ctx.sse(async function* () {
 *   for await (const item of source)
 *     yield { event: 'item', data: item }
 * }())
 *
 * return ctx.sse((stream) => {
 *   const off = bus.on('order', order => stream.send({ event: 'order', data: order }))
 *   stream.onClose(off)
 * })
 * ```
 */
export function eventStream(source: SseSource, options: SseOptions = {}): Response {
  const encoder = new TextEncoder()
  const abort = new AbortController()
  const hooks: Array<() => void> = []
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let timer: ReturnType<typeof setInterval> | undefined

  function write(text: string): void {
    if (abort.signal.aborted)
      return
    try {
      controller.enqueue(encoder.encode(text))
    }
    catch {
      close()
    }
  }
  function close(): void {
    if (abort.signal.aborted)
      return
    abort.abort()
    clearInterval(timer)
    options.signal?.removeEventListener('abort', close)
    try {
      controller.close()
    }
    catch {}
    for (const hook of hooks.splice(0)) {
      try {
        hook()
      }
      catch (error) {
        options.onError?.(error)
      }
    }
  }
  const stream: SseStream = {
    send: event => write(encodeSseEvent(event)),
    comment: text => write(encodeComment(text)),
    close,
    get closed() {
      return abort.signal.aborted
    },
    signal: abort.signal,
    onClose(hook) {
      if (abort.signal.aborted)
        hook()
      else
        hooks.push(hook)
    },
  }

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      if (options.signal?.aborted) {
        close()
        return
      }
      options.signal?.addEventListener('abort', close, { once: true })
      const heartbeat = options.heartbeat === false
        ? 0
        : parseDuration(options.heartbeat ?? 15) * 1000
      if (heartbeat > 0) {
        timer = setInterval(write, heartbeat, ': ping\n\n')
        unref(timer)
      }
      run(source, stream).catch((error: unknown) => {
        options.onError?.(error)
        close()
      })
    },
    cancel: close,
  })

  const headers = new Headers({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    // 关闭 Nginx 的响应缓冲
    'x-accel-buffering': 'no',
  })
  for (const [name, value] of new Headers(options.headers))
    headers.set(name, value)
  return new Response(body, { status: options.status ?? 200, headers })
}

async function run(source: SseSource, stream: SseStream): Promise<void> {
  if (typeof source === 'function') {
    await source(stream)
    return
  }
  const iterator = source[Symbol.asyncIterator]()
  stream.onClose(() => {
    Promise.resolve(iterator.return?.()).catch(() => {})
  })
  try {
    while (!stream.closed) {
      const result = await iterator.next()
      if (result.done)
        break
      stream.send(result.value)
    }
  }
  finally {
    stream.close()
  }
}
