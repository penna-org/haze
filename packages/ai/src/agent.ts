import type { GenerateTextResult } from './generate-text'
import type { ConversationMemory } from './memory'
import type { CallSettings } from './prompt'
import type { ModelRef } from './registry'
import type { StreamTextOptions, StreamTextResult } from './stream-text'
import type { Tool, ToolSet } from './tool'
import type { LanguageModel, Message, UserContentPart } from './types'
import { AIError } from './errors'
import { generateText } from './generate-text'
import { jsonSchema } from './schema'
import { streamText } from './stream-text'
import { defineTool } from './tool'

/** 子 Agent 工具的参数 */
const taskSchema = jsonSchema<{ task: string }>({
  type: 'object',
  properties: {
    task: { type: 'string', description: 'The task for the agent, with all the context it needs' },
  },
  required: ['task'],
  additionalProperties: false,
}, {
  validate: value => typeof (value as { task?: unknown })?.task === 'string'
    ? { success: true, value: value as { task: string } }
    : {
        success: false,
        issues: [
          {
            message: 'task must be a string',
            path: ['task'],
          },
        ],
      },
})

export interface AgentOptions<TOOLS extends ToolSet = ToolSet> extends CallSettings {
  /** 名称（作为子 Agent 工具时的默认工具名、日志） */
  name?: string
  model?: ModelRef<LanguageModel>
  /** 系统提示；函数形式在每次调用时求值（可读取上下文） */
  instructions?: string | ((context: AgentCallContext) => string | Promise<string>)
  tools?: TOOLS
  /** 最多步数，默认 10 */
  maxSteps?: number
  /** 对话记忆：调用时传 conversationId 即自动读取与保存历史 */
  memory?: ConversationMemory
}

export interface AgentCallContext {
  conversationId?: string
  /** 调用方传入的任意数据（当前用户等），供 instructions 函数使用 */
  context?: Record<string, unknown>
}

export interface AgentCallOptions extends CallSettings, AgentCallContext {
  prompt?: string | UserContentPart[]
  messages?: Message[]
  /** 覆盖 Agent 的模型 */
  model?: ModelRef<LanguageModel>
}

export interface Agent<TOOLS extends ToolSet = ToolSet> {
  readonly name?: string
  readonly options: AgentOptions<TOOLS>
  /** 运行到完成（多步工具调用） */
  generate: (options: AgentCallOptions) => Promise<GenerateTextResult>
  /** 流式运行；对话记忆在完成后保存 */
  stream: (options: AgentCallOptions & Pick<StreamTextOptions, 'onEvent' | 'onFinish' | 'onError'>) => Promise<StreamTextResult>
  /** 作为其它 Agent 的工具（多 Agent 协作）：输入 { task }，返回子 Agent 的最终文本 */
  asTool: (options?: { description?: string }) => Tool<{ task: string }, string>
}

/**
 * 定义 Agent：模型 + 指令 + 工具 + 记忆，多步调用工具直到完成。
 *
 * ```ts
 * export const support = defineAgent({
 *   model: 'anthropic:claude-opus-5-5',
 *   instructions: 'You are a support agent for Acme.',
 *   tools: { lookupOrder, refund },
 *   memory: memoryConversationStore({ maxMessages: 40 }),
 * })
 * const { text } = await support.generate({ prompt, conversationId: user.id })
 * ```
 */
export function defineAgent<TOOLS extends ToolSet = ToolSet>(options: AgentOptions<TOOLS>): Agent<TOOLS> {
  const { name, instructions, memory, maxSteps, tools, model, ...settings } = options

  const prepare = async (call: AgentCallOptions): Promise<{ system?: string, messages: Message[], incoming: Message[] }> => {
    if (call.prompt === undefined && !call.messages?.length)
      throw new AIError('Agent call requires a prompt or messages')
    const incoming: Message[] = [
      ...(call.messages ?? []),
      ...(call.prompt !== undefined
        ? [
            { role: 'user', content: call.prompt } as Message,
          ]
        : []),
    ]
    const history = memory && call.conversationId
      ? await memory.load(call.conversationId)
      : []
    const system = typeof instructions === 'function'
      ? await instructions(call)
      : instructions
    return {
      system,
      messages: [
        ...history,
        ...incoming,
      ],
      incoming,
    }
  }

  const remember = async (call: AgentCallOptions, incoming: Message[], response: Message[]): Promise<void> => {
    if (memory && call.conversationId) {
      await memory.append(call.conversationId, [
        ...incoming,
        ...response,
      ])
    }
  }

  const settingsFor = (call: AgentCallOptions): CallSettings => {
    const { prompt: _prompt, messages: _messages, conversationId: _id, context: _context, model: _model, ...rest } = call
    return {
      ...settings,
      ...rest,
    }
  }

  const agent: Agent<TOOLS> = {
    name,
    options,
    async generate(call) {
      const { system, messages, incoming } = await prepare(call)
      const result = await generateText({
        ...settingsFor(call),
        model: call.model ?? model,
        system,
        messages,
        tools,
        maxSteps: maxSteps ?? 10,
      })
      await remember(call, incoming, result.response.messages)
      return result
    },
    async stream(call) {
      const { system, messages, incoming } = await prepare(call)
      return streamText({
        ...settingsFor(call),
        model: call.model ?? model,
        system,
        messages,
        tools,
        maxSteps: maxSteps ?? 10,
        onEvent: call.onEvent,
        onError: call.onError,
        onFinish: async (result) => {
          await remember(call, incoming, result.responseMessages)
          await call.onFinish?.(result)
        },
      })
    },
    asTool(toolOptions = {}) {
      return defineTool({
        description: toolOptions.description ?? `Delegate a task to the ${name ?? 'sub'} agent and get its answer`,
        parameters: taskSchema,
        execute: async ({ task }) => (await agent.generate({ prompt: task })).text,
      }) as Tool<{ task: string }, string>
    },
  }
  return agent
}
