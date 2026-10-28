import type { GenerateTextOptions, StepResult, ToolCall, ToolResult } from './generate-text'
import type { ToolSet } from './tool'
import type { AssistantContentPart, FinishReason, Message, ModelStreamPart, ProviderMetadata, ResponseInfo, Usage } from './types'
import { defaultMaxSteps, executeToolCall, shouldContinue, toolResultMessage } from './generate-text'
import { abortSignal, safeParseJSON, withRetry } from './http'
import { addUsage, buildMessages, buildRequest, buildToolSpecs, emptyUsage, reasoningOf, resolveToolChoice, textOf } from './prompt'
import { toEventStreamResponse } from './protocol/sse'
import { resolveModel } from './registry'

/** streamText 产生的事件（fullStream） */
export type TextStreamEvent
  = | { type: 'start' }
    | { type: 'start-step', stepNumber: number }
    | { type: 'text-delta', text: string }
    | { type: 'reasoning-delta', text: string }
    | { type: 'tool-call-start', toolCallId: string, toolName: string }
    | { type: 'tool-call-delta', toolCallId: string, inputDelta: string }
    | ({ type: 'tool-call' } & ToolCall)
    | ({ type: 'tool-result' } & ToolResult)
    | { type: 'finish-step', stepNumber: number, finishReason: FinishReason, usage: Usage }
    | { type: 'finish', finishReason: FinishReason, totalUsage: Usage }
    | { type: 'error', error: unknown }

export interface StreamTextOptions<TOOLS extends ToolSet = ToolSet> extends GenerateTextOptions<TOOLS> {
  /** 每个事件 */
  onEvent?: (event: TextStreamEvent) => void | Promise<void>
  /** 全部完成后（含所有步骤） */
  onFinish?: (result: { text: string, finishReason: FinishReason, totalUsage: Usage, steps: StepResult[], responseMessages: Message[] }) => void | Promise<void>
  /** 出错时（错误同时作为 error 事件输出）；默认打印到 console.error */
  onError?: (error: unknown) => void | Promise<void>
}

/** 可被多个消费者重放的事件缓冲 */
class ReplayBuffer<T> {
  readonly #items: T[] = []
  #done = false
  #waiters: Array<() => void> = []

  push(item: T): void {
    this.#items.push(item)
    this.#wake()
  }

  close(): void {
    this.#done = true
    this.#wake()
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0))
      waiter()
  }

  async* iterate(): AsyncGenerator<T> {
    let index = 0
    while (true) {
      if (index < this.#items.length) {
        yield this.#items[index++]
        continue
      }
      if (this.#done)
        return
      await new Promise<void>(resolve => this.#waiters.push(resolve))
    }
  }
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // 未被等待时不产生 unhandled rejection
  promise.catch(() => {})
  return { promise, resolve, reject }
}

export interface StreamTextResult {
  /** 所有事件，可多次迭代（每次从头开始） */
  readonly fullStream: AsyncIterable<TextStreamEvent>
  /** 只含文本增量 */
  readonly textStream: AsyncIterable<string>
  readonly text: Promise<string>
  readonly reasoningText: Promise<string | undefined>
  readonly toolCalls: Promise<ToolCall[]>
  readonly toolResults: Promise<ToolResult[]>
  readonly finishReason: Promise<FinishReason>
  readonly usage: Promise<Usage>
  readonly totalUsage: Promise<Usage>
  readonly steps: Promise<StepResult[]>
  readonly response: Promise<ResponseInfo & { messages: Message[] }>
  /** 等待全部完成（等价于 await text，但不抛出） */
  consume: () => Promise<void>
  /** hazejs 的 SSE 协议（配合 @hazejs/ai/client 的 createChat / useChat） */
  toResponse: (init?: ResponseInit & { sendReasoning?: boolean }) => Response
  /** 纯文本流（text/plain） */
  toTextStreamResponse: (init?: ResponseInit) => Response
}

/**
 * 流式生成文本（可多步调用工具）。立即返回，生成在后台进行；控制器中可直接返回 `toResponse()`：
 *
 * ```ts
 * r.post('/api/chat', async ctx => streamText({ model: 'openai:gpt-5', messages: await ctx.body() }).toResponse())
 * ```
 */
export function streamText<TOOLS extends ToolSet = ToolSet>(options: StreamTextOptions<TOOLS>): StreamTextResult {
  const buffer = new ReplayBuffer<TextStreamEvent>()
  const result = {
    text: deferred<string>(),
    reasoningText: deferred<string | undefined>(),
    toolCalls: deferred<ToolCall[]>(),
    toolResults: deferred<ToolResult[]>(),
    finishReason: deferred<FinishReason>(),
    usage: deferred<Usage>(),
    totalUsage: deferred<Usage>(),
    steps: deferred<StepResult[]>(),
    response: deferred<ResponseInfo & { messages: Message[] }>(),
  }
  const emit = async (event: TextStreamEvent): Promise<void> => {
    buffer.push(event)
    await options.onEvent?.(event)
  }

  const run = async (): Promise<void> => {
    const model = resolveModel('language', options.model)
    const messages = buildMessages(options)
    const tools = await buildToolSpecs(options.tools)
    const toolChoice = resolveToolChoice(options.toolChoice, tools)
    const maxSteps = options.maxSteps ?? defaultMaxSteps(options.tools)
    const responseMessages: Message[] = []
    const steps: StepResult[] = []
    let totalUsage = emptyUsage()
    await emit({ type: 'start' })

    for (let stepNumber = 0; ; stepNumber++) {
      await emit({ type: 'start-step', stepNumber })
      const signal = abortSignal(options.abortSignal, options.timeout)
      const stream = await withRetry(() => model.stream(buildRequest(options, [...messages], { tools, toolChoice, signal })), { maxRetries: options.maxRetries, signal: options.abortSignal })

      const content: AssistantContentPart[] = []
      const toolCalls: ToolCall[] = []
      const pending: Array<Promise<ToolResult | undefined>> = []
      let finishReason: FinishReason = 'other'
      let usage = emptyUsage()
      let providerMetadata: ProviderMetadata | undefined
      const warnings: string[] = []
      const response: ResponseInfo = {}
      const appendText = (type: 'text' | 'reasoning', text: string): void => {
        const last = content.at(-1)
        if (last?.type === type && !(type === 'reasoning' && (last as { providerMetadata?: unknown }).providerMetadata)) {
          last.text += text
        }
        else {
          content.push(type === 'text'
            ? { type: 'text', text }
            : { type: 'reasoning', text })
        }
      }

      const reader = stream.getReader()
      try {
        while (true) {
          const { value: part, done } = await reader.read() as { value: ModelStreamPart, done: boolean }
          if (done)
            break
          switch (part.type) {
            case 'response-metadata':
              response.id ??= part.id
              response.modelId ??= part.modelId
              break
            case 'text-delta':
              if (part.text) {
                appendText('text', part.text)
                await emit({ type: 'text-delta', text: part.text })
              }
              break
            case 'reasoning-delta':
              if (part.text) {
                appendText('reasoning', part.text)
                await emit({ type: 'reasoning-delta', text: part.text })
              }
              break
            case 'reasoning-end': {
              const last = content.at(-1)
              if (last?.type === 'reasoning')
                last.providerMetadata = part.providerMetadata
              else if (part.providerMetadata)
                content.push({ type: 'reasoning', text: '', providerMetadata: part.providerMetadata })
              break
            }
            case 'tool-call-start':
              await emit({ type: 'tool-call-start', toolCallId: part.toolCallId, toolName: part.toolName })
              break
            case 'tool-call-delta':
              await emit({ type: 'tool-call-delta', toolCallId: part.toolCallId, inputDelta: part.inputDelta })
              break
            case 'tool-call': {
              const parsed = safeParseJSON(part.input)
              const call: ToolCall = {
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: parsed.success ? parsed.value : part.input,
              }
              content.push({
                type: 'tool-call',
                ...call,
                ...(part.providerMetadata && { providerMetadata: part.providerMetadata }),
              })
              toolCalls.push(call)
              await emit({ type: 'tool-call', ...call })
              // 工具在流继续时就开始执行
              pending.push(executeToolCall(options.tools, call, [
                ...messages,
                {
                  role: 'assistant',
                  content: [...content],
                },
              ], options.abortSignal))
              break
            }
            case 'finish':
              finishReason = part.finishReason
              usage = part.usage
              providerMetadata = part.providerMetadata
              break
            case 'warning':
              warnings.push(part.message)
              break
            case 'error':
              throw part.error
          }
        }
      }
      finally {
        reader.releaseLock()
      }

      if (toolCalls.length && finishReason === 'stop')
        finishReason = 'tool-calls'
      const assistant: Message = { role: 'assistant', content }
      messages.push(assistant)
      responseMessages.push(assistant)
      const executed = (await Promise.all(pending)).filter(Boolean) as ToolResult[]
      for (const toolResult of executed)
        await emit({ type: 'tool-result', ...toolResult })
      if (executed.length) {
        const toolMessage = toolResultMessage(executed)
        messages.push(toolMessage)
        responseMessages.push(toolMessage)
      }

      const step: StepResult = {
        stepNumber,
        text: textOf(content),
        reasoningText: reasoningOf(content),
        content,
        toolCalls,
        toolResults: executed,
        finishReason,
        usage,
        warnings,
        response,
        providerMetadata,
      }
      steps.push(step)
      totalUsage = addUsage(totalUsage, usage)
      await emit({
        type: 'finish-step',
        stepNumber,
        finishReason,
        usage,
      })
      await options.onStepFinish?.(step)
      if (!shouldContinue(step, options.tools, maxSteps, options.stopWhen))
        break
    }

    const last = steps.at(-1)!
    await emit({ type: 'finish', finishReason: last.finishReason, totalUsage })
    result.text.resolve(last.text)
    result.reasoningText.resolve(last.reasoningText)
    result.toolCalls.resolve(last.toolCalls)
    result.toolResults.resolve(last.toolResults)
    result.finishReason.resolve(last.finishReason)
    result.usage.resolve(last.usage)
    result.totalUsage.resolve(totalUsage)
    result.steps.resolve(steps)
    result.response.resolve({ ...last.response, messages: responseMessages })
    await options.onFinish?.({
      text: last.text,
      finishReason: last.finishReason,
      totalUsage,
      steps,
      responseMessages,
    })
  }

  const done = run().catch(async (error) => {
    buffer.push({ type: 'error', error })
    for (const item of Object.values(result))
      item.reject(error)
    if (options.onError)
      await options.onError(error)
    else
      console.error('[hazejs/ai] streamText failed:', error)
  }).finally(() => buffer.close())

  return {
    get fullStream() {
      return {
        [Symbol.asyncIterator]: () => buffer.iterate(),
      }
    },
    get textStream() {
      return {
        async* [Symbol.asyncIterator]() {
          for await (const event of buffer.iterate()) {
            if (event.type === 'text-delta')
              yield event.text
            else if (event.type === 'error')
              throw event.error
          }
        },
      }
    },
    text: result.text.promise,
    reasoningText: result.reasoningText.promise,
    toolCalls: result.toolCalls.promise,
    toolResults: result.toolResults.promise,
    finishReason: result.finishReason.promise,
    usage: result.usage.promise,
    totalUsage: result.totalUsage.promise,
    steps: result.steps.promise,
    response: result.response.promise,
    consume: () => done,
    toResponse(init) {
      return toEventStreamResponse(buffer.iterate(), init)
    },
    toTextStreamResponse(init) {
      const encoder = new TextEncoder()
      const iterator = buffer.iterate()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (true) {
            const { value, done: finished } = await iterator.next()
            if (finished)
              return controller.close()
            if (value.type === 'text-delta')
              return controller.enqueue(encoder.encode(value.text))
          }
        },
        cancel: () => void iterator.return(undefined),
      })
      return new Response(body, {
        status: 200,
        ...init,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-cache',
          ...Object.fromEntries(new Headers(init?.headers)),
        },
      })
    },
  }
}
