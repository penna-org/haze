import { createApplication, defineRoutes } from '@hazejs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { AI, configureAIFromConfig, createOpenAI, createOpenAICompatible, defineAIConfig, parseSSE, registerAIDriver, setModelRegistry } from '../src'
import { aiProvider } from '../src/integration'
import { useMockServer } from './server'

const server = useMockServer()

afterEach(() => {
  AI.restore()
  setModelRegistry(undefined)
})

function boot() {
  return createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      ai: defineAIConfig(() => ({
        default: 'smart',
        aliases: { smart: 'openai:gpt-5', fast: 'local:qwen3' },
        defaults: { embedding: 'openai:text-embedding-3-small' },
        providers: {
          openai: { driver: 'openai', baseURL: server.url, apiKey: 'sk-app' },
          local: { driver: 'ollama', baseURL: server.url },
        },
      })),
    },
    providers: [
      aiProvider(),
    ],
    routes: [
      defineRoutes((r) => {
        r.post('/api/chat', async ctx => AI.streamText({ model: 'fast', messages: (await ctx.body<{ messages: any[] }>()).messages }).toResponse())
        r.get('/api/summary', async () => ({ summary: (await AI.generateText({ prompt: 'Summarize' })).text }))
      }),
    ],
  })
}

describe('hazejs integration', () => {
  it('configures providers from config/ai.ts and streams from a route', async () => {
    server.reply(() => ({
      sse: [
        {
          id: '1',
          choices: [
            {
              index: 0,
              delta: { content: 'Hi from ' },
            },
          ],
        },
        {
          id: '1',
          choices: [
            {
              index: 0,
              delta: { content: 'qwen' },
              finish_reason: 'stop',
            },
          ],
        },
        '[DONE]',
      ],
    }))
    const app = await boot()
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'hello' },
        ],
      }),
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text: string[] = []
    for await (const event of parseSSE(response.body!)) {
      if (event.event === 'text')
        text.push(JSON.parse(event.data).delta)
    }
    expect(text.join('')).toBe('Hi from qwen')
    // 别名 fast → local（ollama 驱动）的 qwen3，无鉴权头
    expect(server.last.json.model).toBe('qwen3')
    expect(server.last.headers.authorization).toBeUndefined()
  })

  it('uses the default model and fakes every model in tests', async () => {
    server.reply(() => ({
      json: {
        choices: [
          {
            message: { content: 'real summary' },
            finish_reason: 'stop',
          },
        ],
      },
    }))
    const app = await boot()
    expect((await (await app.request('/api/summary')).json() as any).data.summary).toBe('real summary')
    expect(server.last.headers.authorization).toBe('Bearer sk-app')

    const fake = AI.fake(['fake summary'])
    expect((await (await app.request('/api/summary')).json() as any).data.summary).toBe('fake summary')
    fake.assertPromptedTimes(1)
    fake.assertPromptContains('Summarize')
    // 直接传入的模型对象同样被替换
    expect((await AI.generateText({
      model: createOpenAI({ baseURL: 'http://127.0.0.1:1' })('x'),
      prompt: 'q',
    })).text).toBe('fake summary')
    const { embedding } = await AI.embed({ value: 'hello' })
    expect(embedding).toHaveLength(8)
    expect((await AI.embed({ value: 'hello' })).embedding).toEqual(embedding)
    expect(() => fake.assertNotPrompted()).toThrow('Expected no model requests, got 2')
  })

  it('reports unknown drivers and supports custom drivers', () => {
    expect(() => configureAIFromConfig({
      providers: {
        x: { driver: 'nope' },
      },
    })).toThrow('unknown driver "nope"')
    // 第三方驱动：键名即厂商名
    registerAIDriver('my-gateway', (settings, name) => createOpenAICompatible({ name, baseURL: settings.url, noAuth: true }))
    configureAIFromConfig({
      providers: {
        gw: { driver: 'my-gateway', url: 'http://gateway.test/v1' },
      },
      default: 'gw:any-model',
    })
    expect(AI.configured).toBe(true)
    expect(AI.model()).toMatchObject({ provider: 'gw', modelId: 'any-model' })
  })
})
