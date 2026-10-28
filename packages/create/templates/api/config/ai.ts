import { defineAIConfig } from '@hazejs/ai'
import { env } from '@hazejs/core'

/**
 * AI：AI.generateText / streamText / generateObject / embed …，模型写作 `厂商:模型` 或别名。
 * 各厂商的 API Key 默认读取环境变量（OPENAI_API_KEY、ANTHROPIC_API_KEY、DEEPSEEK_API_KEY …），也可在此显式设置 apiKey。
 * 内置 driver：openai、anthropic、google、azure、bedrock、cloudflare、deepseek、qwen、moonshot、zhipu、doubao、
 * siliconflow、openrouter、groq、xai、mistral、ollama、openai-compatible。
 */
export default defineAIConfig(() => ({
  // 默认对话模型
  default: env('AI_MODEL', 'openai:gpt-5-mini'),
  // 别名：AI.generateText({ model: 'fast', ... })
  aliases: {
    fast: 'deepseek:deepseek-chat',
  },
  defaults: {
    embedding: 'openai:text-embedding-3-small',
  },
  providers: {
    openai: { driver: 'openai' },
    anthropic: { driver: 'anthropic' },
    deepseek: { driver: 'deepseek' },
    // 本地模型（Ollama），无需 API Key
    ollama: {
      driver: 'ollama',
      baseURL: env('OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
    },
  },
}))
