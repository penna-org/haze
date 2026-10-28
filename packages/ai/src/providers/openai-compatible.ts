import type { ProviderInstance, ProviderSettings } from '../provider'
import type { OpenAIEndpoint } from './openai'
import type { ChatCompat } from './openai-chat'
import { AIError } from '../errors'
import { createProvider, optionalEnv, withoutTrailingSlash } from '../provider'
import { openAIChatModel, openAIEmbeddingModel, openAIImageModel, openAISpeechModel, openAITranscriptionModel } from './openai'

export interface OpenAICompatibleSettings extends ProviderSettings {
  /** 厂商名（ProviderOptions / 错误信息中使用） */
  name: string
  baseURL: string
  /** apiKey 未设置时读取的环境变量 */
  apiKeyEnv?: string
  /** 不需要鉴权（本地 Ollama 等），默认 false */
  noAuth?: boolean
  /** 协议差异 */
  compat?: ChatCompat
  /** 支持的模型类型，默认只有对话与 embedding */
  supports?: Array<'embedding' | 'image' | 'speech' | 'transcription'>
  /** embedding 单次请求的最大条数 */
  embeddingBatchSize?: number
}

/**
 * 任意 OpenAI 兼容的服务（vLLM、LM Studio、自建网关等）：
 *
 * ```ts
 * const local = createOpenAICompatible({ name: 'vllm', baseURL: 'http://localhost:8000/v1' })
 * await generateText({ model: local('Qwen/Qwen3-8B'), prompt })
 * ```
 */
export function createOpenAICompatible(settings: OpenAICompatibleSettings): ProviderInstance {
  const apiKey = (): string | undefined => {
    if (settings.noAuth)
      return settings.apiKey
    const key = settings.apiKey ?? (settings.apiKeyEnv
      ? optionalEnv(settings.apiKeyEnv)
      : undefined)
    if (!key) {
      throw new AIError(`${settings.name} API key is missing. Pass apiKey${settings.apiKeyEnv
        ? ` or set ${settings.apiKeyEnv}`
        : ''}.`)
    }
    return key
  }
  const endpoint: OpenAIEndpoint = {
    provider: settings.name,
    baseURL: withoutTrailingSlash(settings.baseURL),
    headers: () => {
      const key = apiKey()
      return {
        ...(key && { authorization: `Bearer ${key}` }),
        ...settings.headers,
      }
    },
    fetch: settings.fetch,
  }
  const compat: ChatCompat = { maxTokensField: 'max_tokens', structuredOutput: 'json', ...settings.compat }
  const supports = new Set(settings.supports ?? ['embedding'])
  return createProvider(settings.name, {
    languageModel: modelId => openAIChatModel(endpoint, modelId, compat),
    ...(supports.has('embedding') && {
      embeddingModel: (modelId: string) => openAIEmbeddingModel(endpoint, modelId, settings.embeddingBatchSize),
    }),
    ...(supports.has('image') && {
      imageModel: (modelId: string) => openAIImageModel(endpoint, modelId),
    }),
    ...(supports.has('speech') && {
      speechModel: (modelId: string) => openAISpeechModel(endpoint, modelId),
    }),
    ...(supports.has('transcription') && {
      transcriptionModel: (modelId: string) => openAITranscriptionModel(endpoint, modelId),
    }),
  })
}

type PresetSettings = ProviderSettings

interface Preset {
  name: string
  baseURL: string
  apiKeyEnv?: string
  noAuth?: boolean
  compat?: ChatCompat
  supports?: OpenAICompatibleSettings['supports']
  embeddingBatchSize?: number
}

function preset(definition: Preset): (settings?: PresetSettings) => ProviderInstance {
  return (settings = {}) => createOpenAICompatible({
    ...definition,
    ...settings,
    baseURL: settings.baseURL ?? definition.baseURL,
    name: definition.name,
  })
}

/** DeepSeek（deepseek-chat、deepseek-reasoner）。思考模式下的工具调用需要回传推理内容 */
export const createDeepSeek = preset({
  name: 'deepseek',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  compat: { reasoningField: 'reasoning_content', sendReasoning: true, reasoningEffort: false },
  supports: [],
})

/** 通义千问（阿里云百炼 DashScope 兼容模式）；国际站用 baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' */
export const createQwen = preset({
  name: 'qwen',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  compat: { reasoningField: 'reasoning_content', reasoningEffort: false },
  embeddingBatchSize: 10,
})

/** Kimi（月之暗面）；国际站用 baseURL: 'https://api.moonshot.ai/v1' */
export const createMoonshot = preset({
  name: 'moonshot',
  baseURL: 'https://api.moonshot.cn/v1',
  apiKeyEnv: 'MOONSHOT_API_KEY',
  compat: { reasoningField: 'reasoning_content', reasoningEffort: false },
  supports: [],
})

/** 智谱 GLM（BigModel）；国际站用 baseURL: 'https://api.z.ai/api/paas/v4' */
export const createZhipu = preset({
  name: 'zhipu',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKeyEnv: 'ZHIPU_API_KEY',
  compat: { reasoningField: 'reasoning_content', reasoningEffort: false },
})

/** 豆包（火山引擎方舟），模型 ID 可以是推理接入点 ID */
export const createDoubao = preset({
  name: 'doubao',
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKeyEnv: 'ARK_API_KEY',
  compat: { reasoningField: 'reasoning_content', reasoningEffort: false },
})

/** 硅基流动；国际站用 baseURL: 'https://api.siliconflow.com/v1' */
export const createSiliconFlow = preset({
  name: 'siliconflow',
  baseURL: 'https://api.siliconflow.cn/v1',
  apiKeyEnv: 'SILICONFLOW_API_KEY',
  compat: { reasoningField: 'reasoning_content', reasoningEffort: false },
  supports: [
    'embedding',
    'image',
    'speech',
    'transcription',
  ],
})

/** OpenRouter（模型 ID 如 anthropic/claude-sonnet-5-5） */
export const createOpenRouter = preset({
  name: 'openrouter',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  compat: { reasoningField: 'reasoning' },
  supports: ['embedding'],
})

/** Groq */
export const createGroq = preset({
  name: 'groq',
  baseURL: 'https://api.groq.com/openai/v1',
  apiKeyEnv: 'GROQ_API_KEY',
  compat: { reasoningField: 'reasoning' },
  supports: ['transcription', 'speech'],
})

/** xAI（Grok） */
export const createXAI = preset({
  name: 'xai',
  baseURL: 'https://api.x.ai/v1',
  apiKeyEnv: 'XAI_API_KEY',
  compat: { reasoningField: 'reasoning_content', structuredOutput: 'native' },
  supports: ['image'],
})

/** Mistral */
export const createMistral = preset({
  name: 'mistral',
  baseURL: 'https://api.mistral.ai/v1',
  apiKeyEnv: 'MISTRAL_API_KEY',
  compat: { structuredOutput: 'native', reasoningEffort: false },
})

/** Ollama（本地，OpenAI 兼容接口）；无需 API Key */
export const createOllama = preset({
  name: 'ollama',
  baseURL: 'http://localhost:11434/v1',
  noAuth: true,
  compat: { reasoningField: 'reasoning', structuredOutput: 'native' },
})

/** 内置的兼容厂商预设（配置中 driver 的可选值） */
export const COMPATIBLE_PRESETS = {
  deepseek: createDeepSeek,
  qwen: createQwen,
  moonshot: createMoonshot,
  zhipu: createZhipu,
  doubao: createDoubao,
  siliconflow: createSiliconFlow,
  openrouter: createOpenRouter,
  groq: createGroq,
  xai: createXAI,
  mistral: createMistral,
  ollama: createOllama,
} as const
