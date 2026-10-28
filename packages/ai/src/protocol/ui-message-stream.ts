import type { TextStreamEvent } from '../stream-text'
import type { AssistantContentPart, FinishReason, Message, ProviderMetadata, ToolResultPart, UserContentPart } from '../types'

/**
 * 与 Vercel AI SDK UI（`useChat`，@ai-sdk/react / @ai-sdk/vue / @ai-sdk/svelte）互通：
 *
 * - `toUIMessageStreamResponse()`：把 streamText 的事件编码为 AI SDK 的 UI Message Stream 协议（SSE，`x-vercel-ai-ui-message-stream: v1`）
 * - `convertUIMessages()`：把 useChat 发来的 `UIMessage[]`（parts 格式）转换为本库的 `Message[]`
 *
 * 协议参考：https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 *
 * ```ts
 * r.post('/api/chat', async (ctx) => {
 *   const { messages } = await ctx.body<{ messages: UIMessage[] }>()
 *   return streamText({ model: 'openai:gpt-5', messages: convertUIMessages(messages) }).toUIMessageStreamResponse()
 * })
 * ```
 */

export const UI_MESSAGE_STREAM_HEADER = 'x-vercel-ai-ui-message-stream'

/** UI Message Stream 的数据块（本库会输出的部分；字段与 AI SDK 一致） */
export type UIMessageChunk
  = | { type: 'start', messageId?: string }
    | { type: 'start-step' }
    | { type: 'text-start', id: string }
    | { type: 'text-delta', id: string, delta: string }
    | { type: 'text-end', id: string }
    | { type: 'reasoning-start', id: string }
    | { type: 'reasoning-delta', id: string, delta: string }
    | { type: 'reasoning-end', id: string }
    | { type: 'tool-input-start', toolCallId: string, toolName: string }
    | { type: 'tool-input-delta', toolCallId: string, inputTextDelta: string }
    | { type: 'tool-input-available', toolCallId: string, toolName: string, input: unknown }
    | { type: 'tool-output-available', toolCallId: string, output: unknown }
    | { type: 'tool-output-error', toolCallId: string, errorText: string }
    | { type: 'finish-step' }
    | { type: 'finish', finishReason?: FinishReason }
    | { type: 'error', errorText: string }

export interface UIMessageStreamOptions extends ResponseInit {
  /** 写入 start 块的 messageId（省略时由客户端生成） */
  messageId?: string
  /** 是否发送推理内容，默认 true */
  sendReasoning?: boolean
  /** 把错误转换为发给客户端的文本；默认使用 error.message */
  onError?: (error: unknown) => string
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error)
}

/** 工具错误的输出转为文本（AI SDK 的 tool-output-error 只有 errorText） */
function outputText(output: unknown): string {
  return typeof output === 'string'
    ? output
    : JSON.stringify(output)
}

/** 把 streamText 的事件转换为 UI 数据块：负责为文本、推理分配 id 并补齐 start / end */
function createChunkEncoder(options: UIMessageStreamOptions): (event: TextStreamEvent) => UIMessageChunk[] {
  const { sendReasoning = true } = options
  let counter = 0
  /** 当前未结束的文本或推理块 */
  let open: { type: 'text' | 'reasoning', id: string } | undefined

  const close = (chunks: UIMessageChunk[]): UIMessageChunk[] => {
    if (open) {
      chunks.push({
        type: open.type === 'text'
          ? 'text-end'
          : 'reasoning-end',
        id: open.id,
      })
      open = undefined
    }
    return chunks
  }
  const delta = (type: 'text' | 'reasoning', text: string): UIMessageChunk[] => {
    const chunks: UIMessageChunk[] = []
    if (open?.type !== type) {
      close(chunks)
      open = { type, id: `${type}-${counter++}` }
      chunks.push({
        type: type === 'text'
          ? 'text-start'
          : 'reasoning-start',
        id: open.id,
      })
    }
    chunks.push({
      type: type === 'text'
        ? 'text-delta'
        : 'reasoning-delta',
      id: open.id,
      delta: text,
    })
    return chunks
  }

  return (event) => {
    switch (event.type) {
      case 'start':
        return [
          {
            type: 'start',
            ...(options.messageId && { messageId: options.messageId }),
          },
        ]
      case 'start-step':
        return [
          { type: 'start-step' },
        ]
      case 'text-delta':
        return delta('text', event.text)
      case 'reasoning-delta':
        return sendReasoning
          ? delta('reasoning', event.text)
          : []
      case 'tool-call-start':
        return close([]).concat({ type: 'tool-input-start', toolCallId: event.toolCallId, toolName: event.toolName })
      case 'tool-call-delta':
        return [
          { type: 'tool-input-delta', toolCallId: event.toolCallId, inputTextDelta: event.inputDelta },
        ]
      case 'tool-call':
        return close([]).concat({
          type: 'tool-input-available',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        })
      case 'tool-result':
        return close([]).concat(event.isError
          ? {
              type: 'tool-output-error',
              toolCallId: event.toolCallId,
              errorText: outputText(event.output),
            }
          : { type: 'tool-output-available', toolCallId: event.toolCallId, output: event.output })
      case 'finish-step':
        return close([]).concat({ type: 'finish-step' })
      case 'finish':
        return close([]).concat({ type: 'finish', finishReason: event.finishReason })
      case 'error':
        return close([]).concat({
          type: 'error',
          errorText: (options.onError ?? errorText)(event.error),
        })
      default:
        return []
    }
  }
}

/** 编码一个数据块：`data: <JSON>\n\n` */
export function encodeUIMessageChunk(chunk: UIMessageChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * 把 streamText 的事件编码为 AI SDK UI Message Stream 响应，结尾发送 `data: [DONE]`。
 * 一般通过 `streamText(...).toUIMessageStreamResponse()` 调用。
 */
export function toUIMessageStreamResponse(events: AsyncIterator<TextStreamEvent>, init: UIMessageStreamOptions = {}): Response {
  const { messageId: _messageId, sendReasoning: _sendReasoning, onError: _onError, ...responseInit } = init
  const encode = createChunkEncoder(init)
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
          return controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        }
        const chunks = encode(value)
        if (chunks.length)
          return controller.enqueue(encoder.encode(chunks.map(encodeUIMessageChunk).join('')))
      }
    },
    cancel: () => void events.return?.(undefined),
  })
  const headers = new Headers(responseInit.headers)
  headers.set('content-type', 'text/event-stream')
  headers.set('cache-control', 'no-cache')
  headers.set('x-accel-buffering', 'no')
  headers.set(UI_MESSAGE_STREAM_HEADER, 'v1')
  return new Response(body, { status: 200, ...responseInit, headers })
}

// ---------------------------------------------------------------------------
// UIMessage → Message
// ---------------------------------------------------------------------------

export interface UITextPart {
  type: 'text'
  text: string
  state?: 'streaming' | 'done'
  providerMetadata?: ProviderMetadata
}

export interface UIReasoningPart {
  type: 'reasoning'
  text: string
  state?: 'streaming' | 'done'
  providerMetadata?: ProviderMetadata
}

export interface UIFilePart {
  type: 'file'
  /** 托管地址或 data: URL */
  url: string
  mediaType: string
  filename?: string
}

export type UIToolState = 'input-streaming' | 'input-available' | 'approval-requested' | 'approval-responded' | 'output-available' | 'output-error' | 'output-denied'

/** 静态工具 `tool-<name>`，或动态工具 `dynamic-tool`（带 toolName） */
export interface UIToolPart {
  type: `tool-${string}` | 'dynamic-tool'
  toolCallId: string
  toolName?: string
  state: UIToolState
  input?: unknown
  /** 已废弃，output-error 时 input 可能为空 */
  rawInput?: unknown
  output?: unknown
  errorText?: string
  providerExecuted?: boolean
  callProviderMetadata?: ProviderMetadata
}

/** 其它 parts（step-start、source-url、source-document、data-*…）转换时忽略 */
export interface UIOtherPart {
  type: 'step-start' | 'source-url' | 'source-document' | 'reasoning-file' | 'custom' | `data-${string}`
  [key: string]: unknown
}

export type UIMessagePart = UITextPart | UIReasoningPart | UIFilePart | UIToolPart | UIOtherPart

export interface UIMessage {
  id?: string
  role: 'system' | 'user' | 'assistant'
  metadata?: unknown
  parts: UIMessagePart[]
}

function isToolPart(part: UIMessagePart): part is UIToolPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

function toolNameOf(part: UIToolPart): string {
  return part.type === 'dynamic-tool'
    ? part.toolName ?? ''
    : part.type.slice('tool-'.length)
}

/** UI 中的工具状态 → 工具结果（未完成的返回 undefined） */
function toolResultOf(part: UIToolPart): ToolResultPart | undefined {
  const base = {
    type: 'tool-result' as const,
    toolCallId: part.toolCallId,
    toolName: toolNameOf(part),
  }
  switch (part.state) {
    case 'output-available':
      return { ...base, output: part.output }
    case 'output-error':
      return { ...base, output: part.errorText ?? 'Tool execution failed', isError: true }
    case 'output-denied':
      return { ...base, output: 'Tool execution was denied by the user', isError: true }
    default:
      return undefined
  }
}

function textOfParts(parts: UIMessagePart[]): string {
  return parts.flatMap(part => part.type === 'text'
    ? [(part as UITextPart).text]
    : []).join('')
}

/**
 * 把 AI SDK 的 `UIMessage[]` 转换为本库的 `Message[]`：
 *
 * - user：text → 文本、file → 图片（image/*）或文件
 * - assistant：按 `step-start` 分段，每段为一条 assistant 消息（文本、推理、工具调用）+ 一条 tool 消息（工具结果）
 * - 没有结果的工具调用（input-streaming、input-available、等待审批）会被忽略，以免厂商拒绝请求
 * - 其它 parts（source、data-*、step-start）忽略；兼容 AI SDK v4 的 `{ role, content }` 消息
 */
export function convertUIMessages(uiMessages: readonly UIMessage[]): Message[] {
  const messages: Message[] = []
  for (const message of uiMessages) {
    // AI SDK v4：{ role, content: string }
    const parts: UIMessagePart[] = message.parts
      ?? [
        {
          type: 'text',
          text: String((message as { content?: unknown }).content ?? ''),
        },
      ]
    if (message.role === 'system') {
      messages.push({
        role: 'system',
        content: textOfParts(parts),
      })
      continue
    }
    if (message.role === 'user') {
      const content: UserContentPart[] = []
      for (const part of parts) {
        if (part.type === 'text')
          content.push({ type: 'text', text: (part as UITextPart).text })
        else if (part.type === 'file')
          content.push(fileContent(part as UIFilePart))
      }
      messages.push({
        role: 'user',
        content: content.every(part => part.type === 'text')
          ? textOfParts(parts)
          : content,
      })
      continue
    }
    if (message.role !== 'assistant')
      continue

    // assistant：按 step-start 切分为多个步骤
    let content: AssistantContentPart[] = []
    let results: ToolResultPart[] = []
    const flush = (): void => {
      if (content.length)
        messages.push({ role: 'assistant', content })
      if (results.length)
        messages.push({ role: 'tool', content: results })
      content = []
      results = []
    }
    for (const part of parts) {
      if (part.type === 'step-start') {
        flush()
      }
      else if (part.type === 'text') {
        const text = (part as UITextPart).text
        if (text)
          content.push({ type: 'text', text })
      }
      else if (part.type === 'reasoning') {
        const { text, providerMetadata } = part as UIReasoningPart
        if (text || providerMetadata) {
          content.push({
            type: 'reasoning',
            text,
            ...(providerMetadata && { providerMetadata }),
          })
        }
      }
      else if (isToolPart(part)) {
        const result = toolResultOf(part)
        if (!result)
          continue
        content.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: result.toolName,
          input: part.input ?? part.rawInput ?? {},
          ...(part.callProviderMetadata && { providerMetadata: part.callProviderMetadata }),
        })
        results.push(result)
      }
    }
    flush()
  }
  return messages
}

function fileContent(part: UIFilePart): UserContentPart {
  // AI SDK 把 image/* 规范化为 image
  if (part.mediaType === 'image' || part.mediaType.startsWith('image/')) {
    return {
      type: 'image',
      image: part.url,
      ...(part.mediaType !== 'image' && { mediaType: part.mediaType }),
    }
  }
  return {
    type: 'file',
    data: part.url,
    mediaType: part.mediaType,
    ...(part.filename && { filename: part.filename }),
  }
}
