import type { Message } from '@hazejs/ai'
import type { HttpContext } from '@hazejs/core'
import type { ChatSchema } from '~/app/validate/chat'
import { AI } from '@hazejs/ai'
import * as v from 'valibot'

/** 示例工具：模型需要当前时间时调用 */
const currentTime = AI.tool({
  description: 'Get the current date and time on the server',
  parameters: v.object({
    timeZone: v.optional(v.string(), 'Asia/Shanghai'),
  }),
  execute: ({ timeZone }) => new Date().toLocaleString('zh-CN', { timeZone }),
})

/**
 * 流式对话：返回 SSE（text/event-stream），前端用 @hazejs/ai/vue 或 @hazejs/ai/react 的 useChat 接收。
 * 模型在 config/ai.ts 中配置；测试中用 AI.fake() 替换。
 */
export class ChatController {
  chat(ctx: HttpContext<{ body: typeof ChatSchema }>) {
    return AI.streamText({
      system: 'You are a helpful assistant. Answer in the language of the user.',
      messages: ctx.validated.body.messages as Message[],
      tools: { currentTime },
      maxSteps: 5,
    }).toResponse()
  }
}
