import type { ProviderInstance, ProviderSettings } from '../provider'
import type { OpenAIEndpoint } from './openai'
import { AIError } from '../errors'
import { apiKeyLoader, createProvider, optionalEnv, withoutTrailingSlash } from '../provider'
import { openAIChatModel, openAIEmbeddingModel, openAIImageModel, openAISpeechModel, openAITranscriptionModel } from './openai'

/** 旧版（按部署）接口默认使用的 api-version：最新的 GA 版本 */
const DEFAULT_DEPLOYMENT_API_VERSION = '2024-10-21'

export interface AzureSettings extends ProviderSettings {
  /** 资源名：`https://{resourceName}.openai.azure.com`；省略时读取 AZURE_RESOURCE_NAME */
  resourceName?: string
  /**
   * 接口根地址，到 `/openai` 为止（如 `https://my-res.openai.azure.com/openai`、`https://my-res.services.ai.azure.com/openai`）。
   * 设置后忽略 resourceName
   */
  baseURL?: string
  /**
   * api-version 查询参数。v1 接口不需要（设置为 `preview` 可使用预览功能）；
   * 按部署的接口默认 2024-10-21
   */
  apiVersion?: string
  /** 使用旧版按部署的地址：`/openai/deployments/{deployment}/...?api-version=...` */
  useDeploymentURLs?: boolean
}

/**
 * Azure OpenAI（Microsoft Foundry）。模型 ID 为部署名：
 *
 * ```ts
 * const azure = createAzure({ resourceName: 'my-res' })
 * await generateText({ model: azure('my-gpt-5-deployment'), prompt })
 * ```
 *
 * 默认使用 v1 接口（`https://{resourceName}.openai.azure.com/openai/v1`，无需 api-version），
 * 以 `api-key` 请求头鉴权；在 headers 中传入 `authorization: Bearer ...` 时改用 Microsoft Entra ID 令牌。
 */
export function createAzure(settings: AzureSettings = {}): ProviderInstance {
  const apiKey = apiKeyLoader('Azure OpenAI', settings.apiKey, 'AZURE_API_KEY')
  // 调用方自带 Entra ID 令牌时不再要求 API Key
  const hasBearer = Object.keys(settings.headers ?? {}).some(key => key.toLowerCase() === 'authorization')
  const root = (): string => {
    if (settings.baseURL)
      return withoutTrailingSlash(settings.baseURL)
    const resource = settings.resourceName ?? optionalEnv('AZURE_RESOURCE_NAME')
    if (!resource)
      throw new AIError('Azure OpenAI resource name is missing. Pass resourceName or baseURL, or set AZURE_RESOURCE_NAME.')
    return `https://${resource}.openai.azure.com/openai`
  }
  const headers = (): Record<string, string | undefined> => ({
    ...(!hasBearer && {
      'api-key': apiKey(),
    }),
    ...settings.headers,
  })
  // 地址在创建模型时确定：v1 接口共用一个地址，按部署的接口每个部署一个地址
  const endpoint = (deployment: string): OpenAIEndpoint => {
    if (settings.useDeploymentURLs) {
      return {
        provider: 'azure',
        baseURL: `${root()}/deployments/${encodeURIComponent(deployment)}`,
        headers,
        fetch: settings.fetch,
        query: `api-version=${encodeURIComponent(settings.apiVersion ?? DEFAULT_DEPLOYMENT_API_VERSION)}`,
      }
    }
    return {
      provider: 'azure',
      baseURL: `${root()}/v1`,
      headers,
      fetch: settings.fetch,
      query: settings.apiVersion
        ? `api-version=${encodeURIComponent(settings.apiVersion)}`
        : undefined,
    }
  }
  return createProvider('azure', {
    languageModel: modelId => openAIChatModel(endpoint(modelId), modelId, { maxTokensField: 'max_completion_tokens', structuredOutput: 'native' }),
    embeddingModel: modelId => openAIEmbeddingModel(endpoint(modelId), modelId),
    imageModel: modelId => openAIImageModel(endpoint(modelId), modelId),
    speechModel: modelId => openAISpeechModel(endpoint(modelId), modelId),
    transcriptionModel: modelId => openAITranscriptionModel(endpoint(modelId), modelId),
  })
}

/** 读取 AZURE_API_KEY 与 AZURE_RESOURCE_NAME 的默认实例 */
export const azure = createAzure()
