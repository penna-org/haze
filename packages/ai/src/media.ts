import type { ModelRef } from './registry'
import type { DataContent, GeneratedFile, ImageModel, ProviderOptions, SpeechModel, TranscriptionModel, TranscriptionSegment } from './types'
import { abortSignal, withRetry } from './http'
import { resolveModel } from './registry'

interface MediaSettings {
  providerOptions?: ProviderOptions
  headers?: Record<string, string>
  maxRetries?: number
  timeout?: number
  abortSignal?: AbortSignal
}

/** 文生图：n 超过模型单次上限时自动分多次请求 */
export async function generateImage(options: MediaSettings & {
  model?: ModelRef<ImageModel>
  prompt: string
  n?: number
  size?: string
  aspectRatio?: string
  seed?: number
}): Promise<{ image: GeneratedFile, images: GeneratedFile[], revisedPrompts: (string | undefined)[], warnings: string[] }> {
  const model = resolveModel('image', options.model)
  const total = options.n ?? 1
  const perCall = model.maxImagesPerCall ?? total
  const counts: number[] = []
  for (let remaining = total; remaining > 0; remaining -= perCall)
    counts.push(Math.min(perCall, remaining))
  const responses = await Promise.all(counts.map(n => withRetry(() => model.generate({
    prompt: options.prompt,
    n,
    size: options.size,
    aspectRatio: options.aspectRatio,
    seed: options.seed,
    providerOptions: options.providerOptions,
    headers: options.headers,
    signal: abortSignal(options.abortSignal, options.timeout),
  }), { maxRetries: options.maxRetries, signal: options.abortSignal })))
  const images = responses.flatMap(response => response.images)
  return {
    image: images[0],
    images,
    revisedPrompts: responses.flatMap(response => response.revisedPrompts ?? response.images.map(() => undefined)),
    warnings: [
      ...new Set(responses.flatMap(response => response.warnings ?? [])),
    ],
  }
}

/** 语音合成 */
export async function generateSpeech(options: MediaSettings & {
  model?: ModelRef<SpeechModel>
  text: string
  voice?: string
  format?: string
  speed?: number
  instructions?: string
}): Promise<{ audio: GeneratedFile }> {
  const model = resolveModel('speech', options.model)
  const { audio } = await withRetry(() => model.generate({
    text: options.text,
    voice: options.voice,
    format: options.format,
    speed: options.speed,
    instructions: options.instructions,
    providerOptions: options.providerOptions,
    headers: options.headers,
    signal: abortSignal(options.abortSignal, options.timeout),
  }), { maxRetries: options.maxRetries, signal: options.abortSignal })
  return { audio }
}

/** 语音识别 */
export async function transcribe(options: MediaSettings & {
  model?: ModelRef<TranscriptionModel>
  audio: DataContent
  mediaType?: string
  language?: string
  prompt?: string
}): Promise<{ text: string, language?: string, durationInSeconds?: number, segments: TranscriptionSegment[] }> {
  const model = resolveModel('transcription', options.model)
  const result = await withRetry(() => model.transcribe({
    audio: options.audio,
    mediaType: options.mediaType,
    language: options.language,
    prompt: options.prompt,
    providerOptions: options.providerOptions,
    headers: options.headers,
    signal: abortSignal(options.abortSignal, options.timeout),
  }), { maxRetries: options.maxRetries, signal: options.abortSignal })
  return {
    text: result.text,
    language: result.language,
    durationInSeconds: result.durationInSeconds,
    segments: result.segments ?? [],
  }
}
