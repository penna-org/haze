import type { InferSchema, SchemaInput } from './schema'
import type { Message } from './types'

const kTool = Symbol.for('hazejs.ai.tool')

export interface ToolExecutionContext {
  toolCallId: string
  /** 调用工具之前的完整对话 */
  messages: Message[]
  signal?: AbortSignal
}

export interface Tool<Input = any, Output = any> {
  readonly [kTool]: true
  description?: string
  parameters: SchemaInput<Input>
  /** 不提供 execute 时，工具调用交给调用方处理（客户端工具、需要人工确认的操作），循环在此停止 */
  execute?: (input: Input, context: ToolExecutionContext) => Output | Promise<Output>
  /** 要求厂商严格按 schema 生成参数（OpenAI / Anthropic strict），schema 需满足厂商的限制 */
  strict?: boolean
}

/** 工具集合：键即工具名 */
export type ToolSet = Record<string, Tool>

/**
 * 定义工具：
 *
 * ```ts
 * const weather = defineTool({
 *   description: 'Get the weather of a city',
 *   parameters: v.object({ city: v.string() }),
 *   execute: async ({ city }) => fetchWeather(city),
 * })
 * await generateText({ model, prompt, tools: { weather } })
 * ```
 */
export function defineTool<S extends SchemaInput, Output = unknown>(tool: {
  description?: string
  parameters: S
  execute?: (input: InferSchema<S>, context: ToolExecutionContext) => Output | Promise<Output>
  strict?: boolean
}): Tool<InferSchema<S>, Awaited<Output>> {
  return { ...tool, [kTool]: true } as Tool<InferSchema<S>, Awaited<Output>>
}

export function isTool(value: unknown): value is Tool {
  return typeof value === 'object' && value !== null && kTool in value
}
