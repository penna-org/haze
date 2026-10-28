import type { FetchFunction } from '../http'
import type { ProviderInstance, ProviderSettings } from '../provider'
import type { EmbeddingModel, ImageModel, LanguageModel, SpeechModel, TranscriptionModel } from '../types'
import type { ChatCompat } from './openai-chat'
import { generatedFile, loadData } from '../data'
import { compact, postBinary, postForm, postJSON } from '../http'
import { apiKeyLoader, createProvider, withoutTrailingSlash } from '../provider'
import { createChatModel } from './openai-chat'

/** OpenAI 协议的各类模型共用的连接 */
export interface OpenAIEndpoint {
  provider: string
  baseURL: string
  headers: () => Record<string, string | undefined>
  fetch?: FetchFunction
  /** 请求 URL 的查询参数（Azure 的 api-version） */
  query?: string
}

function endpointUrl(endpoint: OpenAIEndpoint, path: string): string {
  return `${endpoint.baseURL}${path}${endpoint.query
    ? `?${endpoint.query}`
    : ''}`
}

export function openAIChatModel(endpoint: OpenAIEndpoint, modelId: string, compat?: ChatCompat): LanguageModel {
  return createChatModel({
    provider: endpoint.provider,
    modelId,
    url: endpointUrl(endpoint, '/chat/completions'),
    headers: endpoint.headers,
    fetch: endpoint.fetch,
    compat,
  })
}

export function openAIEmbeddingModel(endpoint: OpenAIEndpoint, modelId: string, maxBatchSize = 2048): EmbeddingModel {
  return {
    kind: 'embedding',
    provider: endpoint.provider,
    modelId,
    maxBatchSize,
    async embed(request) {
      const { value, headers } = await postJSON({
        provider: endpoint.provider,
        url: endpointUrl(endpoint, '/embeddings'),
        headers: {
          ...endpoint.headers(),
          ...request.headers,
        },
        body: compact({
          model: modelId,
          input: request.values,
          dimensions: request.dimensions,
          encoding_format: 'float',
          ...request.providerOptions?.[endpoint.provider],
        }),
        signal: request.signal,
        fetch: endpoint.fetch,
      })
      const data = [
        ...(value.data ?? []),
      ].sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
      return {
        embeddings: data.map((item: any) => item.embedding),
        usage: value.usage
          ? { tokens: value.usage.prompt_tokens ?? value.usage.total_tokens ?? 0 }
          : undefined,
        response: { modelId: value.model, headers },
      }
    },
  }
}

export function openAIImageModel(endpoint: OpenAIEndpoint, modelId: string): ImageModel {
  // dall-e 需要显式要求 base64，gpt-image 系列总是返回 base64 且不接受 response_format
  const legacy = modelId.startsWith('dall-e')
  return {
    kind: 'image',
    provider: endpoint.provider,
    modelId,
    maxImagesPerCall: modelId === 'dall-e-3'
      ? 1
      : 10,
    async generate(request) {
      const warnings: string[] = []
      if (request.aspectRatio)
        warnings.push('aspectRatio is not supported by OpenAI image models; use size')
      if (request.seed !== undefined)
        warnings.push('seed is not supported by OpenAI image models')
      const { value, headers } = await postJSON({
        provider: endpoint.provider,
        url: endpointUrl(endpoint, '/images/generations'),
        headers: {
          ...endpoint.headers(),
          ...request.headers,
        },
        body: compact({
          model: modelId,
          prompt: request.prompt,
          n: request.n,
          size: request.size,
          response_format: legacy ? 'b64_json' : undefined,
          ...request.providerOptions?.[endpoint.provider],
        }),
        signal: request.signal,
        fetch: endpoint.fetch,
      })
      const format = (request.providerOptions?.[endpoint.provider]?.output_format as string | undefined) ?? 'png'
      return {
        images: (value.data ?? []).map((item: any) => generatedFile(item.b64_json, `image/${format === 'jpg'
          ? 'jpeg'
          : format}`)),
        revisedPrompts: (value.data ?? []).map((item: any) => item.revised_prompt),
        warnings,
        response: { headers },
      }
    },
  }
}

const SPEECH_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
}

export function openAISpeechModel(endpoint: OpenAIEndpoint, modelId: string): SpeechModel {
  return {
    kind: 'speech',
    provider: endpoint.provider,
    modelId,
    async generate(request) {
      const format = request.format ?? 'mp3'
      const { bytes, contentType, headers } = await postBinary({
        provider: endpoint.provider,
        url: endpointUrl(endpoint, '/audio/speech'),
        headers: {
          ...endpoint.headers(),
          ...request.headers,
        },
        body: compact({
          model: modelId,
          input: request.text,
          voice: request.voice ?? 'alloy',
          response_format: format,
          speed: request.speed,
          instructions: request.instructions,
          ...request.providerOptions?.[endpoint.provider],
        }),
        signal: request.signal,
        fetch: endpoint.fetch,
      })
      return {
        audio: generatedFile(bytes, SPEECH_TYPES[format] ?? contentType ?? 'application/octet-stream'),
        response: { headers },
      }
    },
  }
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
}

export function openAITranscriptionModel(endpoint: OpenAIEndpoint, modelId: string): TranscriptionModel {
  // whisper-1 支持带分段与时长的 verbose_json，gpt-4o-transcribe 系列只支持 json
  const verbose = /whisper/.test(modelId)
  return {
    kind: 'transcription',
    provider: endpoint.provider,
    modelId,
    async transcribe(request) {
      const audio = await loadData(request.audio, request.mediaType, request.signal)
      const mediaType = audio.mediaType ?? 'audio/mpeg'
      const form = new FormData()
      form.append('file', new Blob([audio.bytes as Uint8Array<ArrayBuffer>], { type: mediaType }), `audio.${AUDIO_EXTENSIONS[mediaType] ?? 'mp3'}`)
      form.append('model', modelId)
      form.append('response_format', verbose ? 'verbose_json' : 'json')
      if (request.language)
        form.append('language', request.language)
      if (request.prompt)
        form.append('prompt', request.prompt)
      for (const [key, value] of Object.entries(request.providerOptions?.[endpoint.provider] ?? {}))
        form.append(key, String(value))
      const { value, headers } = await postForm({
        provider: endpoint.provider,
        url: endpointUrl(endpoint, '/audio/transcriptions'),
        headers: {
          ...endpoint.headers(),
          ...request.headers,
        },
        body: form,
        signal: request.signal,
        fetch: endpoint.fetch,
      })
      return compact({
        text: value.text ?? '',
        language: value.language,
        durationInSeconds: value.duration,
        segments: value.segments?.map((segment: any) => ({ text: segment.text, start: segment.start, end: segment.end })),
        response: { headers },
      })
    },
  }
}

export interface OpenAISettings extends ProviderSettings {
  /** OpenAI-Organization */
  organization?: string
  /** OpenAI-Project */
  project?: string
}

/**
 * OpenAI：`openai('gpt-5')`、`openai.embeddingModel('text-embedding-3-small')`、
 * `openai.imageModel('gpt-image-1')`、`openai.speechModel('gpt-4o-mini-tts')`、`openai.transcriptionModel('whisper-1')`。
 */
export function createOpenAI(settings: OpenAISettings = {}): ProviderInstance {
  const apiKey = apiKeyLoader('OpenAI', settings.apiKey, 'OPENAI_API_KEY')
  const endpoint: OpenAIEndpoint = {
    provider: 'openai',
    baseURL: withoutTrailingSlash(settings.baseURL ?? 'https://api.openai.com/v1'),
    headers: () => ({
      'authorization': `Bearer ${apiKey()}`,
      'openai-organization': settings.organization,
      'openai-project': settings.project,
      ...settings.headers,
    }),
    fetch: settings.fetch,
  }
  return createProvider('openai', {
    languageModel: modelId => openAIChatModel(endpoint, modelId, { maxTokensField: 'max_completion_tokens', structuredOutput: 'native' }),
    embeddingModel: modelId => openAIEmbeddingModel(endpoint, modelId),
    imageModel: modelId => openAIImageModel(endpoint, modelId),
    speechModel: modelId => openAISpeechModel(endpoint, modelId),
    transcriptionModel: modelId => openAITranscriptionModel(endpoint, modelId),
  })
}

/** 读取 OPENAI_API_KEY 的默认实例 */
export const openai = createOpenAI()
