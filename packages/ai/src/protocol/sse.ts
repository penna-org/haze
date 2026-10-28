import type { TextStreamEvent } from '../stream-text'
import type { FinishReason, Usage } from '../types'

/**
 * hazejs 的流式协议（text/event-stream），每条消息 `event: <类型>` + `data: <JSON>`：
 *
 * | event | data |
 * |-------|------|
 * | `start` | `{}` |
 * | `text` | `{ delta }` |
 * | `reasoning` | `{ delta }` |
 * | `tool-start` | `{ id, name }` |
 * | `tool-call` | `{ id, name, input }` |
 * | `tool-result` | `{ id, name, output, isError? }` |
 * | `step` | `{ step, finishReason, usage }` |
 * | `finish` | `{ finishReason, usage }` |
 * | `error` | `{ message }` |
 * | `done` | `{}`（流结束） |
 */
export type ChatStreamEvent
  = | { type: 'start' }
    | { type: 'text', delta: string }
    | { type: 'reasoning', delta: string }
    | { type: 'tool-start', id: string, name: string }
    | { type: 'tool-call', id: string, name: string, input: unknown }
    | { type: 'tool-result', id: string, name: string, output: unknown, isError?: boolean }
    | { type: 'step', step: number, finishReason: FinishReason, usage: Usage }
    | { type: 'finish', finishReason: FinishReason, usage: Usage }
    | { type: 'error', message: string }
    | { type: 'done' }

export const CHAT_STREAM_HEADER = 'x-hazejs-ai-stream'

function toChatEvent(event: TextStreamEvent, sendReasoning: boolean): ChatStreamEvent | undefined {
  switch (event.type) {
    case 'start':
      return { type: 'start' }
    case 'text-delta':
      return { type: 'text', delta: event.text }
    case 'reasoning-delta':
      return sendReasoning
        ? { type: 'reasoning', delta: event.text }
        : undefined
    case 'tool-call-start':
      return { type: 'tool-start', id: event.toolCallId, name: event.toolName }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: event.toolCallId,
        name: event.toolName,
        input: event.input,
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        id: event.toolCallId,
        name: event.toolName,
        output: event.output,
        ...(event.isError && { isError: true }),
      }
    case 'finish-step':
      return {
        type: 'step',
        step: event.stepNumber,
        finishReason: event.finishReason,
        usage: event.usage,
      }
    case 'finish':
      return { type: 'finish', finishReason: event.finishReason, usage: event.totalUsage }
    case 'error':
      return {
        type: 'error',
        message: event.error instanceof Error
          ? event.error.message
          : String(event.error),
      }
    default:
      return undefined
  }
}

export function encodeChatEvent(event: ChatStreamEvent): string {
  const { type, ...data } = event
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

export function toEventStreamResponse(events: AsyncIterator<TextStreamEvent>, init: ResponseInit & { sendReasoning?: boolean } = {}): Response {
  const { sendReasoning = true, ...responseInit } = init
  const encoder = new TextEncoder()
  let finished = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (finished)
          return controller.close()
        const { value, done } = await events.next()
        if (done) {
          finished = true
          return controller.enqueue(encoder.encode(encodeChatEvent({ type: 'done' })))
        }
        const event = toChatEvent(value, sendReasoning)
        if (event)
          return controller.enqueue(encoder.encode(encodeChatEvent(event)))
      }
    },
    cancel: () => void events.return?.(undefined),
  })
  const headers = new Headers(responseInit.headers)
  headers.set('content-type', 'text/event-stream; charset=utf-8')
  headers.set('cache-control', 'no-cache, no-transform')
  headers.set('x-accel-buffering', 'no')
  headers.set(CHAT_STREAM_HEADER, 'v1')
  return new Response(body, { status: 200, ...responseInit, headers })
}
