import type { EmbeddingModel, ImageModel, LanguageModel, SpeechModel, TranscriptionModel } from './types'
import { NoSuchModelError } from './errors'
import { instrumentModel } from './telemetry'

/** 厂商：按模型 ID 创建各类模型 */
export interface Provider {
  readonly name: string
  languageModel: (modelId: string) => LanguageModel
  embeddingModel?: (modelId: string) => EmbeddingModel
  imageModel?: (modelId: string) => ImageModel
  speechModel?: (modelId: string) => SpeechModel
  transcriptionModel?: (modelId: string) => TranscriptionModel
}

export type ModelKind = 'language' | 'embedding' | 'image' | 'speech' | 'transcription'

export interface ModelByKind {
  language: LanguageModel
  embedding: EmbeddingModel
  image: ImageModel
  speech: SpeechModel
  transcription: TranscriptionModel
}

const factory: { [K in ModelKind]: keyof Provider } = {
  language: 'languageModel',
  embedding: 'embeddingModel',
  image: 'imageModel',
  speech: 'speechModel',
  transcription: 'transcriptionModel',
}

/** 模型引用：模型对象，或 `provider:model` / 别名字符串 */
export type ModelRef<M> = M | string

export interface RegistryOptions {
  providers: Record<string, Provider>
  /** 别名：`{ fast: 'openai:gpt-5-mini', smart: 'anthropic:claude-opus-5-5' }` */
  aliases?: Record<string, string>
  /** 各类模型的默认值（调用时省略 model 使用） */
  defaults?: Partial<Record<ModelKind, string>>
}

/** 按字符串解析模型 */
export class ModelRegistry {
  readonly providers: Record<string, Provider>
  readonly aliases: Record<string, string>
  readonly defaults: Partial<Record<ModelKind, string>>

  constructor(options: RegistryOptions) {
    this.providers = options.providers
    this.aliases = options.aliases ?? {}
    this.defaults = options.defaults ?? {}
  }

  resolve<K extends ModelKind>(kind: K, ref: ModelRef<ModelByKind[K]> | undefined): ModelByKind[K] {
    if (ref !== undefined && typeof ref !== 'string')
      return ref
    let id = ref ?? this.defaults[kind]
    if (!id)
      throw new NoSuchModelError(`No ${kind} model given and no default configured`)
    const seen = new Set<string>()
    while (this.aliases[id] && !seen.has(id)) {
      seen.add(id)
      id = this.aliases[id]
    }
    const separator = id.indexOf(':')
    if (separator <= 0)
      throw new NoSuchModelError(`Model "${id}" must be written as "provider:model" or be a configured alias`)
    const providerName = id.slice(0, separator)
    const provider = this.providers[providerName]
    if (!provider)
      throw new NoSuchModelError(`Unknown AI provider "${providerName}" (configured: ${Object.keys(this.providers).join(', ') || 'none'})`)
    const create = provider[factory[kind]] as ((modelId: string) => ModelByKind[K]) | undefined
    if (!create)
      throw new NoSuchModelError(`Provider "${providerName}" does not support ${kind} models`)
    return create.call(provider, id.slice(separator + 1))
  }
}

let registry: ModelRegistry | undefined

/** 设置全局注册表：字符串形式的模型从这里解析（框架集成或 configureAI() 设置） */
export function setModelRegistry(value: ModelRegistry | undefined): void {
  registry = value
}

export function getModelRegistry(): ModelRegistry | undefined {
  return registry
}

type ModelOverride = <K extends ModelKind>(kind: K, ref: ModelRef<ModelByKind[K]> | undefined) => ModelByKind[K]

let override: ModelOverride | undefined

/** 测试替身：设置后所有模型（包括直接传入的模型对象）都从这里解析（AI.fake() 使用） */
export function setModelOverride(value: ModelOverride | undefined): void {
  override = value
}

export function resolveModel<K extends ModelKind>(kind: K, ref: ModelRef<ModelByKind[K]> | undefined): ModelByKind[K] {
  // 有遥测监听者（开发面板 / OpenTelemetry）时记录模型、token 与耗时
  return instrumentModel(kind, resolveRawModel(kind, ref))
}

function resolveRawModel<K extends ModelKind>(kind: K, ref: ModelRef<ModelByKind[K]> | undefined): ModelByKind[K] {
  if (override)
    return override(kind, ref)
  if (ref !== undefined && typeof ref !== 'string')
    return ref
  if (!registry)
    throw new NoSuchModelError(`Cannot resolve model "${ref ?? '(default)'}": no providers are configured. Pass a model object (e.g. openai('gpt-5')) or call configureAI({...}).`)
  return registry.resolve(kind, ref)
}
