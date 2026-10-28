import type { CallSettings, PromptInput } from './prompt'
import type { ModelRef } from './registry'
import type { InferSchema, SchemaInput } from './schema'
import type { FinishReason, LanguageModel, Message, ModelRequest, ModelStreamPart, ResponseInfo, ToolSpec, Usage } from './types'
import { NoObjectGeneratedError } from './errors'
import { abortSignal, safeParseJSON, withRetry } from './http'
import { buildMessages, buildRequest, textOf } from './prompt'
import { resolveModel } from './registry'
import { formatIssues, toSchema, validateWithSchema } from './schema'

export interface GenerateObjectOptions<S extends SchemaInput> extends PromptInput, CallSettings {
  model?: ModelRef<LanguageModel>
  schema: S
  /** 部分厂商用作 schema 名称（OpenAI json_schema.name），默认 response */
  schemaName?: string
  schemaDescription?: string
  /**
   * 实现方式：auto（按模型能力选择）、native（JSON Schema 约束输出）、json（JSON 模式 + 提示中附 schema）、tool（借一次工具调用）
   */
  mode?: 'auto' | 'native' | 'json' | 'tool'
}

export interface GenerateObjectResult<T> {
  object: T
  finishReason: FinishReason
  usage: Usage
  warnings: string[]
  response: ResponseInfo
}

const TOOL_NAME = 'json'

function jsonInstruction(schema: Record<string, unknown>): string {
  return `Respond only with a JSON value that satisfies this JSON Schema, without any other text or code fences:\n${JSON.stringify(schema)}`
}

/** 取出模型输出中的 JSON（容忍 ```json 代码块） */
export function extractJSON(text: string): string {
  const start = text.indexOf('```')
  if (start === -1)
    return text.trim()
  // 跳过 ```json 这一行的语言标记
  const bodyStart = text.indexOf('\n', start)
  const end = text.indexOf('```', bodyStart === -1
    ? start + 3
    : bodyStart)
  if (bodyStart === -1 || end === -1)
    return text.trim()
  return text.slice(bodyStart + 1, end).trim()
}

async function prepare<S extends SchemaInput>(options: GenerateObjectOptions<S>): Promise<{ model: LanguageModel, mode: 'native' | 'json' | 'tool', request: (signal?: AbortSignal) => ModelRequest, schema: Awaited<ReturnType<typeof toSchema>> }> {
  const model = resolveModel('language', options.model)
  const schema = await toSchema(options.schema)
  const mode = !options.mode || options.mode === 'auto'
    ? model.structuredOutput ?? 'json'
    : options.mode
  const messages: Message[] = buildMessages(options)
  if (mode === 'json') {
    messages.unshift({
      role: 'system',
      content: jsonInstruction(schema.jsonSchema),
    })
  }
  const tool: ToolSpec = { name: TOOL_NAME, description: options.schemaDescription ?? 'Respond with the result', parameters: schema.jsonSchema }
  return {
    model,
    mode,
    schema,
    request: signal => buildRequest(options, messages, {
      signal,
      ...(mode === 'tool'
        ? {
            tools: [tool],
            toolChoice: { toolName: TOOL_NAME },
          }
        : {
            responseFormat: {
              type: 'json',
              ...(mode === 'native' && { schema: schema.jsonSchema }),
              name: options.schemaName ?? 'response',
              description: options.schemaDescription,
            },
          }),
    }),
  }
}

async function parseObject<T>(text: string, schema: Awaited<ReturnType<typeof toSchema>>): Promise<T> {
  const parsed = safeParseJSON(extractJSON(text))
  if (!parsed.success)
    throw new NoObjectGeneratedError('Model output is not valid JSON', { text, cause: parsed.error })
  const validated = await validateWithSchema(schema, parsed.value)
  if (!validated.success)
    throw new NoObjectGeneratedError(`Model output does not match the schema: ${formatIssues(validated.issues)}`, { text, issues: validated.issues })
  return validated.value as T
}

/**
 * 生成符合 schema 的对象（结果经过 schema 校验）：
 *
 * ```ts
 * const { object } = await generateObject({ model, schema: v.object({ title: v.string(), tags: v.array(v.string()) }), prompt })
 * ```
 */
export async function generateObject<S extends SchemaInput>(options: GenerateObjectOptions<S>): Promise<GenerateObjectResult<InferSchema<S>>> {
  const { model, mode, schema, request } = await prepare(options)
  const result = await withRetry(() => model.generate(request(abortSignal(options.abortSignal, options.timeout))), { maxRetries: options.maxRetries, signal: options.abortSignal })
  const text = mode === 'tool'
    ? JSON.stringify(result.content.find(part => part.type === 'tool-call')?.input ?? null)
    : textOf(result.content)
  if (result.finishReason === 'length')
    throw new NoObjectGeneratedError('Output was cut off by maxOutputTokens before the object was complete', { text })
  return {
    object: await parseObject<InferSchema<S>>(text, schema),
    finishReason: result.finishReason === 'tool-calls'
      ? 'stop'
      : result.finishReason,
    usage: result.usage,
    warnings: result.warnings ?? [],
    response: result.response ?? {},
  }
}

/**
 * 解析不完整的 JSON（流式输出中途），补齐未闭合的字符串、数组与对象；无法解析时返回 undefined。
 */
export function parsePartialJSON(text: string): unknown {
  const input = extractPartial(text)
  if (!input)
    return undefined
  const complete = safeParseJSON(input)
  if (complete.success)
    return complete.value
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of input) {
    if (inString) {
      if (escaped)
        escaped = false
      else if (char === '\\')
        escaped = true
      else if (char === '"')
        inString = false
      continue
    }
    if (char === '"')
      inString = true
    else if (char === '{')
      stack.push('}')
    else if (char === '[')
      stack.push(']')
    else if (char === '}' || char === ']')
      stack.pop()
  }
  let repaired = input
  if (inString)
    repaired += escaped ? '\\"' : '"'
  // 去掉末尾不完整的键、冒号、逗号或字面量
  const closers = stack.reverse().join('')
  for (let end = repaired.length; end > 0; end--) {
    const candidate = repaired.slice(0, end).replace(/[,:\s]+$/, '').replace(/,\s*"[^"]*"$/, '').replace(/\{\s*"[^"]*"$/, '{')
    const attempt = safeParseJSON(candidate + closersFor(candidate, closers))
    if (attempt.success)
      return attempt.value
  }
  return undefined
}

function extractPartial(text: string): string {
  const fence = /```(?:json)?\s*/i.exec(text)
  const body = fence
    ? text.slice(fence.index + fence[0].length).replace(/```[\s\S]*$/, '')
    : text
  return body.trim()
}

/** 按截断后的文本重新计算需要补齐的括号 */
function closersFor(text: string, fallback: string): string {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      if (escaped)
        escaped = false
      else if (char === '\\')
        escaped = true
      else if (char === '"')
        inString = false
      continue
    }
    if (char === '"')
      inString = true
    else if (char === '{')
      stack.push('}')
    else if (char === '[')
      stack.push(']')
    else if (char === '}' || char === ']')
      stack.pop()
  }
  return inString
    ? fallback
    : stack.reverse().join('')
}

/** 未被等待的 promise 失败时不产生 unhandled rejection */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {})
  return promise
}

export interface StreamObjectResult<T> {
  /** 逐步完善的对象（未经校验），可多次迭代 */
  readonly partialObjectStream: AsyncIterable<Partial<T>>
  /** 最终对象（经过校验） */
  readonly object: Promise<T>
  readonly usage: Promise<Usage>
  readonly finishReason: Promise<FinishReason>
}

/**
 * 流式生成对象：`partialObjectStream` 随生成逐步给出不完整的对象，`object` 为最终校验后的结果。
 */
export function streamObject<S extends SchemaInput>(options: GenerateObjectOptions<S>): StreamObjectResult<InferSchema<S>> {
  type T = InferSchema<S>
  const partials: Array<Partial<T>> = []
  let done = false
  let failure: unknown
  const waiters: Array<() => void> = []
  const wake = (): void => {
    for (const waiter of waiters.splice(0))
      waiter()
  }
  let resolveFinal!: (value: { object: T, usage: Usage, finishReason: FinishReason }) => void
  let rejectFinal!: (error: unknown) => void
  const final = new Promise<{ object: T, usage: Usage, finishReason: FinishReason }>((resolve, reject) => {
    resolveFinal = resolve
    rejectFinal = reject
  })
  final.catch(() => {})

  void (async () => {
    const { model, mode, schema, request } = await prepare(options)
    const stream = await withRetry(() => model.stream(request(abortSignal(options.abortSignal, options.timeout))), { maxRetries: options.maxRetries, signal: options.abortSignal })
    let text = ''
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finishReason: FinishReason = 'other'
    let lastSnapshot = ''
    const reader = stream.getReader()
    while (true) {
      const { value: part, done: finished } = await reader.read() as { value: ModelStreamPart, done: boolean }
      if (finished)
        break
      if (part.type === 'error')
        throw part.error
      if (part.type === 'finish') {
        usage = part.usage
        finishReason = part.finishReason === 'tool-calls'
          ? 'stop'
          : part.finishReason
        continue
      }
      const delta = mode === 'tool'
        ? part.type === 'tool-call-delta'
          ? part.inputDelta
          : ''
        : part.type === 'text-delta'
          ? part.text
          : ''
      if (mode === 'tool' && part.type === 'tool-call' && !text)
        text = part.input
      if (!delta)
        continue
      text += delta
      const partial = parsePartialJSON(text)
      const snapshot = JSON.stringify(partial)
      if (partial !== undefined && snapshot !== lastSnapshot) {
        lastSnapshot = snapshot
        partials.push(partial as Partial<T>)
        wake()
      }
    }
    if (finishReason === 'length')
      throw new NoObjectGeneratedError('Output was cut off by maxOutputTokens before the object was complete', { text })
    resolveFinal({ object: await parseObject<T>(text, schema), usage, finishReason })
  })().catch((error) => {
    failure = error
    rejectFinal(error)
  }).finally(() => {
    done = true
    wake()
  })

  return {
    get partialObjectStream() {
      return {
        async* [Symbol.asyncIterator]() {
          let index = 0
          while (true) {
            if (index < partials.length) {
              yield partials[index++]
              continue
            }
            if (done) {
              if (failure)
                throw failure
              return
            }
            await new Promise<void>(resolve => waiters.push(resolve))
          }
        },
      }
    },
    object: quiet(final.then(result => result.object)),
    usage: quiet(final.then(result => result.usage)),
    finishReason: quiet(final.then(result => result.finishReason)),
  }
}
