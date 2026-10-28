import * as v from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedMany, generateObject, generateText, streamText } from '../src'
import { createAzure } from '../src/providers/azure'
import { useMockServer } from './server'

const server = useMockServer()

function completion(content: string) {
  return {
    json: {
      id: 'chatcmpl-az',
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('azure openai', () => {
  it('uses the v1 API with the api-key header and max_completion_tokens', async () => {
    server.reply(() => completion('Hi'))
    const azure = createAzure({ baseURL: `${server.url}/openai`, apiKey: 'az-key' })
    const result = await generateText({
      model: azure('my-gpt5'),
      prompt: 'Hello',
      maxOutputTokens: 50,
    })
    expect(result.text).toBe('Hi')
    expect(server.last.url).toBe('/openai/v1/chat/completions')
    expect(server.last.headers['api-key']).toBe('az-key')
    expect(server.last.headers.authorization).toBeUndefined()
    expect(server.last.json).toMatchObject({ model: 'my-gpt5', max_completion_tokens: 50 })
  })

  it('appends an explicit api-version to v1 URLs', async () => {
    server.reply(() => completion('ok'))
    const azure = createAzure({ baseURL: `${server.url}/openai/`, apiKey: 'k', apiVersion: 'preview' })
    await generateText({
      model: azure('dep'),
      prompt: 'x',
    })
    expect(server.last.url).toBe('/openai/v1/chat/completions?api-version=preview')
  })

  it('uses deployment URLs with the default api-version', async () => {
    server.reply(request => request.url.includes('/embeddings')
      ? {
          json: {
            data: [
              {
                index: 1,
                embedding: [0, 1],
              },
              {
                index: 0,
                embedding: [1, 0],
              },
            ],
            usage: { prompt_tokens: 3 },
          },
        }
      : completion('ok'))
    const azure = createAzure({ baseURL: `${server.url}/openai`, apiKey: 'k', useDeploymentURLs: true })
    await generateText({
      model: azure('my deployment'),
      prompt: 'x',
    })
    expect(server.last.url).toBe('/openai/deployments/my%20deployment/chat/completions?api-version=2024-10-21')

    const { embeddings } = await embedMany({
      model: azure.embeddingModel!('emb'),
      values: ['a', 'b'],
    })
    expect(embeddings).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect(server.last.url).toBe('/openai/deployments/emb/embeddings?api-version=2024-10-21')
  })

  it('honours a custom api-version for deployment URLs and streams', async () => {
    server.reply(() => ({
      sse: [
        {
          id: 's',
          model: 'gpt-5',
          choices: [
            {
              index: 0,
              delta: { content: 'Hel' },
            },
          ],
        },
        {
          id: 's',
          choices: [
            {
              index: 0,
              delta: { content: 'lo' },
              finish_reason: 'stop',
            },
          ],
        },
        '[DONE]',
      ],
    }))
    const azure = createAzure({
      baseURL: `${server.url}/openai`,
      apiKey: 'k',
      useDeploymentURLs: true,
      apiVersion: '2025-04-01-preview',
    })
    const result = streamText({
      model: azure('dep'),
      prompt: 'x',
    })
    expect(await result.text).toBe('Hello')
    expect(server.last.url).toBe('/openai/deployments/dep/chat/completions?api-version=2025-04-01-preview')
  })

  it('uses native json_schema structured output', async () => {
    server.reply(() => completion('{"name":"Ada"}'))
    const azure = createAzure({ baseURL: `${server.url}/openai`, apiKey: 'k' })
    const { object } = await generateObject({
      model: azure('dep'),
      schema: v.object({
        name: v.string(),
      }),
      prompt: 'x',
    })
    expect(object).toEqual({ name: 'Ada' })
    expect(server.last.json.response_format.type).toBe('json_schema')
  })

  it('reads the resource name and key from the environment', () => {
    vi.stubEnv('AZURE_RESOURCE_NAME', 'my-res')
    vi.stubEnv('AZURE_API_KEY', 'env-key')
    const model = createAzure()('dep')
    expect(model.provider).toBe('azure')
    expect(model.structuredOutput).toBe('native')
  })

  it('builds the default resource URL and sends Entra ID tokens instead of api-key', async () => {
    const calls: Array<{ url: string, headers: Record<string, string> }> = []
    const azure = createAzure({
      resourceName: 'contoso',
      headers: { Authorization: 'Bearer entra-token' },
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          headers: init?.headers as Record<string, string>,
        })
        return new Response(JSON.stringify(completion('ok').json), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    await generateText({
      model: azure('dep'),
      prompt: 'x',
    })
    expect(calls[0].url).toBe('https://contoso.openai.azure.com/openai/v1/chat/completions')
    expect(calls[0].headers.authorization).toBe('Bearer entra-token')
    expect(calls[0].headers['api-key']).toBeUndefined()
  })

  it('reports a missing resource name', () => {
    vi.stubEnv('AZURE_RESOURCE_NAME', '')
    expect(() => createAzure({ apiKey: 'k' })('dep')).toThrow(/AZURE_RESOURCE_NAME/)
  })
})
