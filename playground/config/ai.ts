import type { ModelRequest, Provider } from '@hazejs/ai'
import { defineAIConfig, mockModel } from '@hazejs/ai'

/** 本地 echo 厂商：原样回显最后一条用户消息，不联网、不需要密钥（演示 DevTools 的 AI 面板） */
const echo: Provider = {
  name: 'echo',
  languageModel: modelId => mockModel((request: ModelRequest) => {
    const last = [...request.messages].reverse().find(message => message.role === 'user')
    const text = typeof last?.content === 'string'
      ? last.content
      : last?.content.map(part => part.type === 'text'
        ? part.text
        : '').join('') ?? ''
    return {
      text: `echo: ${text}`,
      usage: { inputTokens: text.length, outputTokens: text.length + 6 },
    }
  }, { provider: 'echo', modelId }),
}

export default defineAIConfig({
  default: 'echo:parrot',
  aliases: { fast: 'echo:parrot' },
  providers: { echo },
})
