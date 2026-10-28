/**
 * @hazejs/ai/client：与框架无关的聊天客户端（浏览器、Node、Workers 均可用）。
 *
 * 配合服务端的 `streamText(...).toResponse()`（hazejs SSE 协议）：
 *
 * ```ts
 * // 服务端
 * r.post('/api/chat', async (ctx) => {
 *   const { messages } = await ctx.body<{ messages: Message[] }>()
 *   return streamText({ model: 'openai:gpt-5', messages, tools }).toResponse()
 * })
 *
 * // 客户端
 * const chat = createChat({ api: '/api/chat' })
 * chat.subscribe(() => render(chat.messages, chat.status))
 * await chat.sendMessage('你好')
 * ```
 *
 * 本模块只依赖与平台无关的代码（不引入任何服务端模块）。
 */
import type { FetchFunction } from '../http'
import type { ChatStreamEvent } from '../protocol/sse'
import type { AssistantContentPart, FinishReason, Message, ToolResultPart, Usage, UserContentPart } from '../types'
import { parseSSE } from '../http'

export type { ChatStreamEvent } from '../protocol/sse'
export type { FinishReason, Message, Usage } from '../types'

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'

export interface ChatTextPart {
  type: 'text'
  text: string
}

export interface ChatReasoningPart {
  type: 'reasoning'
  text: string
}

/** 用户消息的附件（data: URL 或可公开访问的 URL） */
export interface ChatFilePart {
  type: 'file'
  url: string
  mediaType: string
  filename?: string
}

export type ChatToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error'

export interface ChatToolPart {
  type: 'tool'
  toolCallId: string
  toolName: string
  state: ChatToolState
  input?: unknown
  output?: unknown
  errorText?: string
}

export type ChatPart = ChatTextPart | ChatReasoningPart | ChatFilePart | ChatToolPart

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  parts: ChatPart[]
}

/** 可以是值，也可以是每次请求时调用的函数（读取最新的 token 等） */
type Resolvable<T> = T | (() => T | Promise<T>)

export interface ChatRequestOptions {
  /** 合并到请求体（`messages` 之外的字段） */
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

export interface ChatOptions {
  /** 接口地址，默认 /api/chat */
  api?: string
  headers?: Resolvable<Record<string, string>>
  /** 合并到请求体（`messages` 之外的字段，如会话 id） */
  body?: Resolvable<Record<string, unknown>>
  credentials?: 'omit' | 'same-origin' | 'include'
  /** 自定义 fetch（测试、代理等） */
  fetch?: FetchFunction
  initialMessages?: ChatMessage[]
  /** 生成消息 id */
  generateId?: () => string
  /** 收到的每个流事件 */
  onEvent?: (event: ChatStreamEvent) => void
  /** 一次回复完成（含所有工具步骤；被 stop() 中止时同样调用，aborted 为 true） */
  onFinish?: (message: ChatMessage, info: { messages: ChatMessage[], finishReason?: FinishReason, usage?: Usage, aborted: boolean }) => void
  onError?: (error: Error) => void
}

/** 不可变的状态快照：每次变化都会替换为新对象（便于 React useSyncExternalStore / Vue shallowRef） */
export interface ChatState {
  readonly messages: ChatMessage[]
  readonly status: ChatStatus
  readonly error: Error | undefined
}

export interface Chat {
  readonly messages: ChatMessage[]
  readonly status: ChatStatus
  readonly error: Error | undefined
  /** 当前状态快照（每次变化都是新对象） */
  readonly state: ChatState
  /** 发送一条用户消息并流式接收回复；进行中的请求会先被中止 */
  sendMessage: (message: string | { text: string, files?: Array<Omit<ChatFilePart, 'type'>> }, options?: ChatRequestOptions) => Promise<void>
  /** 删除最后一条用户消息之后的回复并重新生成 */
  regenerate: (options?: ChatRequestOptions) => Promise<void>
  /** 中止当前请求（已收到的内容保留） */
  stop: () => void
  setMessages: (messages: ChatMessage[] | ((messages: ChatMessage[]) => ChatMessage[])) => void
  /** 为没有 execute 的工具（在客户端执行）填写结果；之后调用 sendMessage / regenerate 继续对话 */
  addToolResult: (result: { toolCallId: string, output: unknown, isError?: boolean }) => void
  clearError: () => void
  /** 订阅状态变化，返回取消订阅函数 */
  subscribe: (listener: () => void) => () => void
}

let idCounter = 0

/** 默认的 id 生成：不依赖 crypto.randomUUID（非安全上下文的浏览器中不可用） */
export function generateId(): string {
  return `msg_${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 解析 hazejs SSE 协议（`streamText().toResponse()`）为事件；收到 `done` 后结束 */
export async function* parseChatStream(response: Response | ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const body = response instanceof ReadableStream
    ? response
    : response.body
  if (!body)
    return
  for await (const message of parseSSE(body)) {
    const type = message.event ?? 'message'
    let data: Record<string, unknown> = {}
    try {
      data = message.data
        ? JSON.parse(message.data) as Record<string, unknown>
        : {}
    }
    catch {
      continue
    }
    const event = { ...data, type } as ChatStreamEvent
    yield event
    if (event.type === 'done')
      return
  }
}

function textOf(parts: ChatPart[]): string {
  return parts.flatMap(part => part.type === 'text'
    ? [part.text]
    : []).join('')
}

function toolResultOf(part: ChatToolPart): ToolResultPart | undefined {
  if (part.state === 'output-available') {
    return {
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: part.output,
    }
  }
  if (part.state === 'output-error') {
    return {
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: part.errorText ?? part.output,
      isError: true,
    }
  }
  return undefined
}

/**
 * 把 UI 消息转换为可直接交给 `streamText({ messages })` 的 `Message[]`：
 *
 * - assistant 消息中，工具调用之后再出现文本或推理视为新的一步：拆为 assistant（调用）+ tool（结果）+ assistant（后续内容）
 * - 还没有结果的工具调用会被忽略（厂商要求每个调用都有结果）
 * - 推理只回传文本（DeepSeek 等在工具循环中需要 reasoning_content）
 */
export function toModelMessages(uiMessages: readonly ChatMessage[]): Message[] {
  const messages: Message[] = []
  for (const message of uiMessages) {
    if (message.role === 'system') {
      messages.push({
        role: 'system',
        content: textOf(message.parts),
      })
      continue
    }
    if (message.role === 'user') {
      if (message.parts.every(part => part.type === 'text')) {
        messages.push({
          role: 'user',
          content: textOf(message.parts),
        })
        continue
      }
      const content: UserContentPart[] = []
      for (const part of message.parts) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text })
        }
        else if (part.type === 'file') {
          content.push(part.mediaType.startsWith('image/')
            ? { type: 'image', image: part.url, mediaType: part.mediaType }
            : {
                type: 'file',
                data: part.url,
                mediaType: part.mediaType,
                ...(part.filename && { filename: part.filename }),
              })
        }
      }
      messages.push({ role: 'user', content })
      continue
    }

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
    for (const part of message.parts) {
      if (part.type === 'tool') {
        const result = toolResultOf(part)
        if (!result)
          continue
        content.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? {},
        })
        results.push(result)
      }
      else if (part.type === 'text' || part.type === 'reasoning') {
        // 工具结果之后的内容属于下一步
        if (results.length)
          flush()
        if (part.text)
          content.push({ type: part.type, text: part.text })
      }
    }
    flush()
  }
  return messages
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(String(error))
}

async function resolve<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  return typeof value === 'function'
    ? await (value as () => T | Promise<T>)()
    : value
}

/**
 * 创建聊天状态容器。POST `{ messages: Message[], ...body }` 到 `api`，按 hazejs SSE 协议增量更新最后一条 assistant 消息。
 * 框架绑定见 `@hazejs/ai/vue` 与 `@hazejs/ai/react`。
 */
export function createChat(options: ChatOptions = {}): Chat {
  const { api = '/api/chat', generateId: newId = generateId } = options
  const listeners = new Set<() => void>()
  let state: ChatState = {
    messages: options.initialMessages ?? [],
    status: 'ready',
    error: undefined,
  }
  let controller: AbortController | undefined
  let pending: Promise<void> | undefined

  const setState = (patch: Partial<ChatState>): void => {
    state = {
      ...state,
      ...patch,
    }
    for (const listener of [...listeners])
      listener()
  }

  /** 替换最后一条 assistant 消息（不可变更新） */
  const updateAssistant = (id: string, update: (parts: ChatPart[]) => ChatPart[]): void => {
    const messages = state.messages.slice()
    const index = messages.findLastIndex(message => message.id === id)
    if (index === -1)
      return
    messages[index] = {
      ...messages[index],
      parts: update(messages[index].parts),
    }
    setState({ messages })
  }

  const appendText = (parts: ChatPart[], type: 'text' | 'reasoning', delta: string): ChatPart[] => {
    const last = parts.at(-1)
    return last?.type === type
      ? [
          ...parts.slice(0, -1),
          { type, text: last.text + delta },
        ]
      : [
          ...parts,
          { type, text: delta },
        ]
  }

  const upsertTool = (parts: ChatPart[], toolCallId: string, toolName: string, patch: Partial<ChatToolPart>): ChatPart[] => {
    const index = parts.findIndex(part => part.type === 'tool' && part.toolCallId === toolCallId)
    if (index === -1) {
      return [
        ...parts,
        {
          type: 'tool',
          toolCallId,
          toolName,
          state: 'input-streaming',
          ...patch,
        },
      ]
    }
    const next = parts.slice()
    next[index] = {
      ...(parts[index] as ChatToolPart),
      ...patch,
    }
    return next
  }

  const applyEvent = (assistantId: string, event: ChatStreamEvent): void => {
    switch (event.type) {
      case 'text':
      case 'reasoning':
        updateAssistant(assistantId, parts => appendText(parts, event.type === 'text'
          ? 'text'
          : 'reasoning', event.delta))
        break
      case 'tool-start':
        updateAssistant(assistantId, parts => upsertTool(parts, event.id, event.name, { state: 'input-streaming' }))
        break
      case 'tool-call':
        updateAssistant(assistantId, parts => upsertTool(parts, event.id, event.name, { state: 'input-available', input: event.input }))
        break
      case 'tool-result':
        updateAssistant(assistantId, parts => upsertTool(parts, event.id, event.name, event.isError
          ? {
              state: 'output-error',
              errorText: typeof event.output === 'string'
                ? event.output
                : JSON.stringify(event.output),
            }
          : { state: 'output-available', output: event.output }))
        break
    }
  }

  const request = async (requestOptions: ChatRequestOptions = {}): Promise<void> => {
    const abort = new AbortController()
    controller = abort
    setState({ status: 'submitted', error: undefined })
    let assistantId: string | undefined
    let finishReason: FinishReason | undefined
    let usage: Usage | undefined
    let aborted = false
    try {
      const fetcher = options.fetch ?? globalThis.fetch
      const response = await fetcher(api, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          ...await resolve(options.headers),
          ...requestOptions.headers,
        },
        body: JSON.stringify({
          ...await resolve(options.body),
          ...requestOptions.body,
          messages: toModelMessages(state.messages),
        }),
        ...(options.credentials && { credentials: options.credentials }),
        signal: abort.signal,
      })
      if (!response.ok)
        throw new Error(await response.text().catch(() => '') || `Request failed with status ${response.status}`)
      if (!response.body)
        throw new Error('The response has no body')

      // 中止时让读取立即结束（自定义 fetch 返回的流可能不受 signal 控制）
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: abort.signal })
      for await (const event of parseChatStream(body)) {
        options.onEvent?.(event)
        if (event.type === 'error')
          throw new Error(event.message)
        if (event.type === 'done')
          break
        if (event.type === 'finish') {
          finishReason = event.finishReason
          usage = event.usage
        }
        if (!assistantId) {
          assistantId = newId()
          setState({
            messages: [
              ...state.messages,
              { id: assistantId, role: 'assistant', parts: [] },
            ],
            status: 'streaming',
          })
        }
        applyEvent(assistantId, event)
      }
    }
    catch (error) {
      // 被 stop() 中止时，读取抛出的错误（AbortError 等）不算失败
      if (!abort.signal.aborted) {
        if (controller === abort) {
          const err = toError(error)
          setState({ status: 'error', error: err })
          options.onError?.(err)
        }
        return
      }
      aborted = true
    }
    finally {
      if (controller === abort)
        controller = undefined
    }
    if (state.status !== 'error')
      setState({ status: 'ready' })
    const message = state.messages.find(item => item.id === assistantId)
    if (message) {
      options.onFinish?.(message, {
        messages: state.messages,
        finishReason,
        usage,
        aborted,
      })
    }
  }

  const run = async (prepare: () => void, requestOptions?: ChatRequestOptions): Promise<void> => {
    if (pending) {
      controller?.abort()
      await pending
    }
    prepare()
    const task = request(requestOptions)
    pending = task
    try {
      await task
    }
    finally {
      if (pending === task)
        pending = undefined
    }
  }

  return {
    get messages() {
      return state.messages
    },
    get status() {
      return state.status
    },
    get error() {
      return state.error
    },
    get state() {
      return state
    },
    sendMessage(message, requestOptions) {
      const { text, files = [] } = typeof message === 'string'
        ? { text: message }
        : message
      return run(() => {
        const parts: ChatPart[] = files.map(file => ({ type: 'file', ...file }))
        if (text)
          parts.push({ type: 'text', text })
        setState({
          messages: [
            ...state.messages,
            {
              id: newId(),
              role: 'user',
              parts,
            },
          ],
        })
      }, requestOptions)
    },
    regenerate(requestOptions) {
      return run(() => {
        const index = state.messages.findLastIndex(message => message.role === 'user')
        if (index === -1)
          throw new Error('There is no user message to regenerate a response for')
        setState({
          messages: state.messages.slice(0, index + 1),
        })
      }, requestOptions)
    },
    stop() {
      controller?.abort()
    },
    setMessages(messages) {
      setState({
        messages: typeof messages === 'function'
          ? messages(state.messages)
          : messages,
      })
    },
    addToolResult({ toolCallId, output, isError }) {
      const index = state.messages.findLastIndex(message => message.parts.some(part => part.type === 'tool' && part.toolCallId === toolCallId))
      if (index === -1)
        throw new Error(`No tool call with id "${toolCallId}"`)
      const messages = state.messages.slice()
      messages[index] = {
        ...messages[index],
        parts: messages[index].parts.map(part => part.type === 'tool' && part.toolCallId === toolCallId
          ? {
              ...part,
              ...(isError
                ? {
                    state: 'output-error' as const,
                    errorText: typeof output === 'string'
                      ? output
                      : JSON.stringify(output),
                  }
                : { state: 'output-available' as const, output }),
            }
          : part),
      }
      setState({ messages })
    },
    clearError() {
      if (state.error || state.status === 'error')
        setState({ status: 'ready', error: undefined })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
