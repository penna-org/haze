import type { WorkersAIBinding } from '../src/providers/cloudflare'
import { Buffer } from 'node:buffer'
import * as v from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineTool, embedMany, generateImage, generateObject, generateText, streamText } from '../src'
import { createWorkersAI } from '../src/providers/cloudflare'
import { useMockServer } from './server'

const server = useMockServer()

afterEach(() => {
  vi.unstubAllEnvs()
})

/** 记录调用并按顺序返回结果的假绑定 */
function fakeBinding(...results: unknown[]): WorkersAIBinding & { calls: Array<{ model: string, inputs: any, options?: any }> } {
  const calls: Array<{ model: string, inputs: any, options?: any }> = []
  return {
    calls,
    async run(model, inputs, options) {
      calls.push({ model, inputs, options })
      const next = results.shift()
      return typeof next === 'function'
        ? next()
        : next
    },
  }
}

function sseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = chunks.map(chunk => `data: ${typeof chunk === 'string'
    ? chunk
    : JSON.stringify(chunk)}\n\n`).join('')
  return new Response(text).body!
}

describe('workers ai rest', () => {
  it('calls the OpenAI-compatible endpoints with a bearer token', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acc-1')
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'cf-token')
    const calls: Array<{ url: string, headers: Record<string, string>, body: any }> = []
    const ai = createWorkersAI({
      gateway: 'my-gateway',
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)),
        })
        const json = String(url).endsWith('/embeddings')
          ? {
              data: [
                {
                  index: 0,
                  embedding: [0.5],
                },
              ],
            }
          : {
              id: 'c',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Hi' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            }
        return new Response(JSON.stringify(json), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const result = await generateText({
      model: ai('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
      prompt: 'Hello',
      maxOutputTokens: 64,
      reasoning: { effort: 'low' },
    })
    expect(result.text).toBe('Hi')
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc-1/ai/v1/chat/completions')
    expect(calls[0].headers.authorization).toBe('Bearer cf-token')
    expect(calls[0].headers['cf-aig-gateway-id']).toBe('my-gateway')
    expect(calls[0].body).toEqual({
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 64,
    })

    await embedMany({
      model: ai.embeddingModel!('@cf/baai/bge-m3'),
      values: ['a'],
    })
    expect(calls[1].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc-1/ai/v1/embeddings')
  })

  it('uses json mode for structured output and the run endpoint for images', async () => {
    server.reply(request => request.url.startsWith('/run/')
      ? {
          json: {
            result: {
              image: Buffer.from([0xFF, 0xD8, 0xFF, 1]).toString('base64'),
            },
            success: true,
          },
        }
      : {
          json: {
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"name":"Ada"}' },
                finish_reason: 'stop',
              },
            ],
          },
        })
    const ai = createWorkersAI({ baseURL: `${server.url}/v1`, apiKey: 'k' })
    const { object } = await generateObject({
      model: ai('@cf/meta/llama-3.1-8b-instruct'),
      schema: v.object({
        name: v.string(),
      }),
      prompt: 'x',
    })
    expect(object).toEqual({ name: 'Ada' })
    expect(server.last.url).toBe('/v1/chat/completions')
    expect(server.last.json.response_format).toEqual({ type: 'json_object' })

    const { image } = await generateImage({
      model: ai.imageModel!('@cf/black-forest-labs/flux-1-schnell'),
      prompt: 'A cat',
      seed: 3,
    })
    expect(server.last.url).toBe('/run/@cf/black-forest-labs/flux-1-schnell')
    expect(server.last.json).toEqual({ prompt: 'A cat', seed: 3 })
    expect(image.mediaType).toBe('image/jpeg')
  })

  it('accepts raw image bytes from the run endpoint', async () => {
    server.reply(() => ({
      body: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 2]),
      headers: { 'content-type': 'image/png' },
    }))
    const ai = createWorkersAI({ baseURL: `${server.url}/v1`, apiKey: 'k' })
    const { image } = await generateImage({
      model: ai.imageModel!('@cf/stabilityai/stable-diffusion-xl-base-1.0'),
      prompt: 'x',
      size: '512x768',
    })
    expect(image.mediaType).toBe('image/png')
    expect([...image.data]).toEqual([0x89, 0x50, 0x4E, 0x47, 2])
    expect(server.last.json).toEqual({ prompt: 'x', width: 512, height: 768 })
  })

  it('reports a missing account id', () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '')
    expect(() => createWorkersAI({ apiKey: 'k' })('m')).toThrow(/CLOUDFLARE_ACCOUNT_ID/)
  })
})

describe('workers ai binding', () => {
  it('runs chat with tools and maps tool calls through a full loop', async () => {
    const binding = fakeBinding(
      {
        response: '',
        tool_calls: [
          {
            name: 'weather',
            arguments: { city: 'Paris' },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      },
      {
        response: 'Sunny',
        usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
      },
    )
    const ai = createWorkersAI({
      binding,
      gateway: { id: 'gw', skipCache: true },
    })
    const weather = defineTool({
      description: 'Weather',
      parameters: v.object({
        city: v.string(),
      }),
      execute: () => ({ sky: 'clear' }),
    })
    const result = await generateText({
      model: ai('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
      system: 'Be brief',
      prompt: 'Weather?',
      tools: { weather },
      maxOutputTokens: 200,
      temperature: 0.1,
    })
    expect(result.text).toBe('Sunny')
    expect(result.steps[0].finishReason).toBe('tool-calls')
    expect(result.totalUsage.inputTokens).toBe(30)
    const [first, second] = binding.calls
    expect(first.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    expect(first.options).toEqual({
      gateway: { id: 'gw', skipCache: true },
    })
    expect(first.inputs).toEqual({
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Weather?' },
      ],
      tools: [
        {
          name: 'weather',
          description: 'Weather',
          parameters: expect.objectContaining({ type: 'object' }),
        },
      ],
      max_tokens: 200,
      temperature: 0.1,
    })
    const callId = result.steps[0].toolCalls[0].toolCallId
    expect(callId).toMatch(/^call_/)
    expect(second.inputs.messages.slice(2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: callId,
        name: 'weather',
        content: '{"sky":"clear"}',
      },
    ])
  })

  it('maps json mode and object responses', async () => {
    const binding = fakeBinding({
      response: { name: 'Ada' },
    })
    const ai = createWorkersAI({ binding })
    const { object } = await generateObject({
      model: ai('@cf/meta/llama-3.1-8b-instruct'),
      schema: v.object({
        name: v.string(),
      }),
      prompt: 'x',
    })
    expect(object).toEqual({ name: 'Ada' })
    expect(binding.calls[0].inputs.response_format).toEqual({ type: 'json_object' })
    expect(binding.calls[0].options).toBeUndefined()
  })

  it('accepts OpenAI-style choices from newer models', async () => {
    const binding = fakeBinding({
      choices: [
        {
          message: { role: 'assistant', content: 'Answer', reasoning_content: 'hmm' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    const result = await generateText({
      model: createWorkersAI({ binding })('@cf/qwen/qwq-32b'),
      prompt: 'x',
    })
    expect(result.text).toBe('Answer')
    expect(result.reasoningText).toBe('hmm')
  })

  it('streams SSE chunks from the binding', async () => {
    const binding = fakeBinding(() => sseStream([
      { response: 'Hel' },
      { response: 'lo', p: 'abc' },
      {
        response: '',
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
      '[DONE]',
    ]))
    const result = streamText({
      model: createWorkersAI({ binding })('@cf/meta/llama-3.1-8b-instruct'),
      prompt: 'x',
      stopSequences: ['END'],
    })
    const deltas: string[] = []
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta')
        deltas.push(part.text)
    }
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(await result.usage).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6 })
    expect(binding.calls[0].inputs.stream).toBe(true)
    expect((await result.steps)[0].warnings).toEqual(['stopSequences is not supported by Workers AI and was ignored'])
  })

  it('streams tool calls from the binding', async () => {
    const binding = fakeBinding(
      () => sseStream([
        {
          response: '',
          tool_calls: [
            {
              name: 'lookup',
              arguments: { q: 'x' },
            },
          ],
        },
        '[DONE]',
      ]),
      () => sseStream([
        { response: 'done' },
        '[DONE]',
      ]),
    )
    const lookup = defineTool({
      description: 'Lookup',
      parameters: v.object({
        q: v.string(),
      }),
      execute: ({ q }) => q.toUpperCase(),
    })
    const result = streamText({
      model: createWorkersAI({ binding })('@cf/m'),
      prompt: 'x',
      tools: { lookup },
    })
    expect(await result.text).toBe('done')
    const steps = await result.steps
    expect(steps[0].toolCalls[0]).toMatchObject({
      toolName: 'lookup',
      input: { q: 'x' },
    })
    expect(binding.calls[1].inputs.messages.at(-1)).toMatchObject({ role: 'tool', name: 'lookup', content: 'X' })
  })

  it('embeds and generates images through the binding', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 7])
    const binding = fakeBinding(
      {
        shape: [2, 2],
        data: [
          [1, 0],
          [0, 1],
        ],
      },
      {
        image: Buffer.from([0xFF, 0xD8, 0xFF, 0]).toString('base64'),
      },
      () => new Response(png).body,
    )
    const ai = createWorkersAI({ binding })
    const { embeddings } = await embedMany({
      model: ai.embeddingModel!('@cf/baai/bge-base-en-v1.5'),
      values: ['a', 'b'],
    })
    expect(embeddings).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect(binding.calls[0].inputs).toEqual({
      text: ['a', 'b'],
    })

    const flux = await generateImage({
      model: ai.imageModel!('@cf/black-forest-labs/flux-1-schnell'),
      prompt: 'A cat',
      providerOptions: {
        cloudflare: { steps: 4 },
      },
    })
    expect(flux.image.mediaType).toBe('image/jpeg')
    expect(binding.calls[1].inputs).toEqual({ prompt: 'A cat', steps: 4 })

    const sdxl = await generateImage({
      model: ai.imageModel!('@cf/stabilityai/stable-diffusion-xl-base-1.0'),
      prompt: 'A dog',
    })
    expect(sdxl.image.mediaType).toBe('image/png')
    expect([...sdxl.image.data]).toEqual([...png])
  })
})
