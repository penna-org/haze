import type { CallSettings, PromptInput } from './prompt'
import type { ModelRef } from './registry'
import type { ToolSet } from './tool'
import type { AssistantContentPart, FinishReason, LanguageModel, Message, ProviderMetadata, ResponseInfo, ToolCallPart, ToolChoice, ToolResultPart, Usage } from './types'
import { InvalidToolCallError } from './errors'
import { abortSignal, withRetry } from './http'
import { addUsage, buildMessages, buildRequest, buildToolSpecs, emptyUsage, reasoningOf, resolveToolChoice, textOf } from './prompt'
import { resolveModel } from './registry'
import { formatIssues, toSchema, validateWithSchema } from './schema'

export interface ToolCall {
  toolCallId: string
  toolName: string
  input: unknown
}

export interface ToolResult extends ToolCall {
  output: unknown
  isError?: boolean
}

export interface StepResult {
  /** 从 0 开始 */
  stepNumber: number
  text: string
  reasoningText?: string
  content: AssistantContentPart[]
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  finishReason: FinishReason
  usage: Usage
  warnings: string[]
  response?: ResponseInfo
  providerMetadata?: ProviderMetadata
}

export interface ToolLoopOptions<TOOLS extends ToolSet> {
  tools?: TOOLS
  toolChoice?: ToolChoice
  /**
   * 最多执行的步数（一次模型调用为一步）。模型调用带 execute 的工具后，结果回传给模型继续生成，
   * 直到不再调用工具或达到上限。默认：有可执行的工具时 10，否则 1。
   */
  maxSteps?: number
  /** 额外的停止条件，在每一步之后检查 */
  stopWhen?: (step: StepResult) => boolean
  onStepFinish?: (step: StepResult) => void | Promise<void>
}

export interface GenerateTextOptions<TOOLS extends ToolSet = ToolSet> extends PromptInput, CallSettings, ToolLoopOptions<TOOLS> {
  /** 模型对象，或 `provider:model` / 别名（需要已配置厂商） */
  model?: ModelRef<LanguageModel>
}

export interface GenerateTextResult {
  /** 最后一步的文本 */
  text: string
  reasoningText?: string
  /** 最后一步的工具调用与结果 */
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  finishReason: FinishReason
  /** 最后一步的用量 */
  usage: Usage
  /** 所有步骤的总用量 */
  totalUsage: Usage
  steps: StepResult[]
  warnings: string[]
  response: ResponseInfo & {
    /** 本次生成新增的消息（assistant 与 tool），追加到历史即可继续对话 */
    messages: Message[]
  }
  providerMetadata?: ProviderMetadata
}

export function defaultMaxSteps(tools: ToolSet | undefined): number {
  return tools && Object.values(tools).some(tool => tool.execute)
    ? 10
    : 1
}

/** 校验并执行一次工具调用；参数错误与执行异常作为错误结果回传给模型 */
export async function executeToolCall(tools: ToolSet | undefined, call: ToolCall, messages: Message[], signal?: AbortSignal): Promise<ToolResult | undefined> {
  const tool = tools?.[call.toolName]
  if (!tool)
    throw new InvalidToolCallError(`Model called an unknown tool "${call.toolName}"`, { toolName: call.toolName, input: call.input })
  const schema = await toSchema(tool.parameters)
  const validated = await validateWithSchema(schema, call.input)
  if (!validated.success)
    return { ...call, output: `Invalid arguments for tool "${call.toolName}": ${formatIssues(validated.issues)}`, isError: true }
  if (!tool.execute)
    return undefined
  try {
    const output = await tool.execute(validated.value, { toolCallId: call.toolCallId, messages, signal })
    return { ...call, input: validated.value, output }
  }
  catch (error) {
    if (signal?.aborted)
      throw error
    return {
      ...call,
      output: error instanceof Error
        ? error.message
        : String(error),
      isError: true,
    }
  }
}

export function toolResultMessage(results: ToolResult[]): Message {
  return {
    role: 'tool',
    content: results.map((result): ToolResultPart => ({
      type: 'tool-result',
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      output: result.output,
      ...(result.isError && { isError: true }),
    })),
  }
}

export function shouldContinue(step: StepResult, tools: ToolSet | undefined, maxSteps: number, stopWhen?: (step: StepResult) => boolean): boolean {
  if (step.finishReason !== 'tool-calls' || !step.toolCalls.length)
    return false
  // 有工具没有 execute（交给调用方处理）时停止
  if (step.toolCalls.some(call => !tools?.[call.toolName]?.execute))
    return false
  if (step.stepNumber + 1 >= maxSteps)
    return false
  return !stopWhen?.(step)
}

/**
 * 生成文本（可多步调用工具）：
 *
 * ```ts
 * const { text } = await generateText({ model: 'openai:gpt-5', prompt: 'Hello' })
 * ```
 */
export async function generateText<TOOLS extends ToolSet = ToolSet>(options: GenerateTextOptions<TOOLS>): Promise<GenerateTextResult> {
  const model = resolveModel('language', options.model)
  const initial = buildMessages(options)
  const tools = await buildToolSpecs(options.tools)
  const toolChoice = resolveToolChoice(options.toolChoice, tools)
  const maxSteps = options.maxSteps ?? defaultMaxSteps(options.tools)
  const messages = [...initial]
  const responseMessages: Message[] = []
  const steps: StepResult[] = []
  let totalUsage = emptyUsage()

  for (let stepNumber = 0; ; stepNumber++) {
    const signal = abortSignal(options.abortSignal, options.timeout)
    const result = await withRetry(() => model.generate(buildRequest(options, [...messages], { tools, toolChoice, signal })), { maxRetries: options.maxRetries, signal: options.abortSignal })
    const toolCalls = result.content.filter((part): part is ToolCallPart => part.type === 'tool-call').map(({ toolCallId, toolName, input }) => ({ toolCallId, toolName, input }))
    const assistant: Message = { role: 'assistant', content: result.content }
    messages.push(assistant)
    responseMessages.push(assistant)

    const executed = result.finishReason === 'tool-calls' || toolCalls.length
      ? (await Promise.all(toolCalls.map(call => executeToolCall(options.tools, call, messages, options.abortSignal)))).filter(Boolean) as ToolResult[]
      : []
    if (executed.length) {
      const toolMessage = toolResultMessage(executed)
      messages.push(toolMessage)
      responseMessages.push(toolMessage)
    }

    const step: StepResult = {
      stepNumber,
      text: textOf(result.content),
      reasoningText: reasoningOf(result.content),
      content: result.content,
      toolCalls,
      toolResults: executed,
      finishReason: toolCalls.length && result.finishReason === 'stop'
        ? 'tool-calls'
        : result.finishReason,
      usage: result.usage,
      warnings: result.warnings ?? [],
      response: result.response,
      providerMetadata: result.providerMetadata,
    }
    steps.push(step)
    totalUsage = addUsage(totalUsage, result.usage)
    await options.onStepFinish?.(step)
    if (!shouldContinue(step, options.tools, maxSteps, options.stopWhen))
      break
  }

  const last = steps.at(-1)!
  return {
    text: last.text,
    reasoningText: last.reasoningText,
    toolCalls: last.toolCalls,
    toolResults: last.toolResults,
    finishReason: last.finishReason,
    usage: last.usage,
    totalUsage,
    steps,
    warnings: steps.flatMap(step => step.warnings),
    response: { ...last.response, messages: responseMessages },
    providerMetadata: last.providerMetadata,
  }
}
