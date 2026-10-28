import type { MockModel, MockReply } from './testing'
import type { EmbeddingModel, ImageModel, ModelRequest, SpeechModel, TranscriptionModel } from './types'
import { generatedFile } from './data'
import { AIError } from './errors'
import { setModelOverride } from './registry'
import { mockModel } from './testing'

/** 1x1 透明 PNG */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 确定性的伪向量：相同文本得到相同向量 */
function fakeVector(text: string, dimensions = 8): number[] {
  const vector = Array.from<number>({ length: dimensions }).fill(0)
  for (let index = 0; index < text.length; index++)
    vector[index % dimensions] += text.charCodeAt(index) % 97 / 97
  return vector
}

export interface AIFake {
  /** 所有对话模型调用都由它回答 */
  readonly model: MockModel
  /** 收到的对话请求 */
  readonly requests: ModelRequest[]
  /** 有请求满足条件（默认任意请求） */
  assertPrompted: (predicate?: (request: ModelRequest) => boolean) => void
  assertNotPrompted: () => void
  assertPromptedTimes: (times: number) => void
  /** 任一请求的消息文本中包含该内容 */
  assertPromptContains: (text: string) => void
}

function requestText(request: ModelRequest): string {
  return request.messages.map((message) => {
    if (typeof message.content === 'string')
      return message.content
    return message.content.map(part => 'text' in part
      ? part.text
      : '').join(' ')
  }).join('\n')
}

/**
 * 测试替身：之后的所有模型调用（字符串或模型对象）都不访问网络，
 * 对话模型按 replies 依次回复，embedding / 图像 / 语音返回确定性的假数据。
 */
export function fakeAI(replies?: MockReply[] | MockReply): AIFake {
  const model = mockModel(replies ?? 'Fake AI response', { provider: 'fake', modelId: 'fake' })
  const embedding: EmbeddingModel = {
    kind: 'embedding',
    provider: 'fake',
    modelId: 'fake',
    embed: async ({ values, dimensions }) => ({
      embeddings: values.map(value => fakeVector(value, dimensions)),
    }),
  }
  const image: ImageModel = {
    kind: 'image',
    provider: 'fake',
    modelId: 'fake',
    generate: async ({ n }) => ({
      images: Array.from({ length: n ?? 1 }, () => generatedFile(PIXEL, 'image/png')),
    }),
  }
  const speech: SpeechModel = {
    kind: 'speech',
    provider: 'fake',
    modelId: 'fake',
    generate: async () => ({
      audio: generatedFile(new Uint8Array(), 'audio/mpeg'),
    }),
  }
  const transcription: TranscriptionModel = {
    kind: 'transcription',
    provider: 'fake',
    modelId: 'fake',
    transcribe: async () => ({ text: 'Fake transcript' }),
  }
  const models = {
    language: model,
    embedding,
    image,
    speech,
    transcription,
  }
  setModelOverride(kind => models[kind] as never)
  const fail = (message: string): never => {
    throw new AIError(message)
  }
  return {
    model,
    requests: model.requests,
    assertPrompted(predicate) {
      if (!model.requests.some(request => !predicate || predicate(request)))
        fail(predicate ? 'Expected a model request matching the predicate' : 'Expected the model to be prompted')
    },
    assertNotPrompted() {
      if (model.requests.length)
        fail(`Expected no model requests, got ${model.requests.length}`)
    },
    assertPromptedTimes(times) {
      if (model.requests.length !== times)
        fail(`Expected ${times} model request(s), got ${model.requests.length}`)
    },
    assertPromptContains(text) {
      if (!model.requests.some(request => requestText(request).includes(text)))
        fail(`Expected a prompt containing "${text}"`)
    },
  }
}

export function restoreAI(): void {
  setModelOverride(undefined)
}
