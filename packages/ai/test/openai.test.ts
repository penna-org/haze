import { Buffer } from 'node:buffer'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { APICallError, createDeepSeek, createOllama, createOpenAI, defineTool, embedMany, generateImage, generateObject, generateSpeech, generateText, streamText, transcribe } from '../src'
import { useMockServer } from './server'

const server = useMockServer()
const openai = () => createOpenAI({ baseURL: server.url, apiKey: 'sk-test', organization: 'org-1' })

function completion(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    json: {
      id: 'chatcmpl-1',
      model: 'gpt-5-2026',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', ...message },
          finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
      ...extra,
    },
  }
}

describe('openai chat completions', () => {
  it('sends messages, settings and auth headers, and maps the response', async () => {
    server.reply(() => completion({ content: 'Hello!' }))
    const result = await generateText({
      model: openai()('gpt-5'),
      system: 'Be kind',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'image', image: 'https://example.com/cat.png' },
          ],
        },
      ],
      maxOutputTokens: 100,
      temperature: 0.2,
      stopSequences: ['END'],
      reasoning: { effort: 'low' },
      providerOptions: {
        openai: { service_tier: 'flex' },
      },
    })
    expect(result.text).toBe('Hello!')
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
      reasoningTokens: 3,
      cachedInputTokens: 4,
    })
    expect(result.response).toMatchObject({ id: 'chatcmpl-1', modelId: 'gpt-5-2026' })
    expect(server.last.url).toBe('/chat/completions')
    expect(server.last.headers.authorization).toBe('Bearer sk-test')
    expect(server.last.headers['openai-organization']).toBe('org-1')
    expect(server.last.json).toEqual({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Be kind' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hi' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/cat.png' },
            },
          ],
        },
      ],
      max_completion_tokens: 100,
      temperature: 0.2,
      stop: ['END'],
      reasoning_effort: 'low',
      service_tier: 'flex',
    })
  })

  it('runs a tool loop over the wire', async () => {
    let call = 0
    server.reply(() => ++call === 1
      ? completion({
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Paris"}' },
            },
          ],
        })
      : completion({ content: 'Sunny' }))
    const weather = defineTool({
      description: 'Weather',
      parameters: v.object({
        city: v.string(),
      }),
      execute: () => ({ sky: 'clear' }),
    })
    const result = await generateText({
      model: openai()('gpt-5'),
      prompt: 'Weather?',
      tools: { weather },
      toolChoice: 'auto',
    })
    expect(result.text).toBe('Sunny')
    const first = server.requests[0].json
    expect(first.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'weather',
          description: 'Weather',
          parameters: expect.objectContaining({ type: 'object' }),
        },
      },
    ])
    expect(first.tool_choice).toBe('auto')
    expect(server.requests[1].json.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"sky":"clear"}' },
    ])
  })

  it('streams text, tool calls and usage', async () => {
    server.reply(() => ({
      sse: [
        {
          id: 'c1',
          model: 'gpt-5',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Hel' },
            },
          ],
        },
        {
          id: 'c1',
          model: 'gpt-5',
          choices: [
            {
              index: 0,
              delta: { content: 'lo' },
            },
          ],
        },
        {
          id: 'c1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_9',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":' },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'c1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"x"}' },
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'c1',
          choices: [
            { index: 0, delta: {}, finish_reason: 'tool_calls' },
          ],
        },
        {
          id: 'c1',
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
        '[DONE]',
      ],
    }))
    const lookup = defineTool({
      parameters: v.object({
        q: v.string(),
      }),
    })
    const result = streamText({
      model: openai()('gpt-5'),
      prompt: 'x',
      tools: { lookup },
    })
    const events = []
    for await (const event of result.fullStream)
      events.push(event)
    expect(await result.text).toBe('Hello')
    expect(await result.toolCalls).toEqual([
      {
        toolCallId: 'call_9',
        toolName: 'lookup',
        input: { q: 'x' },
      },
    ])
    expect(await result.finishReason).toBe('tool-calls')
    expect(await result.usage).toEqual({ inputTokens: 5, outputTokens: 3, totalTokens: 8 })
    expect(events.filter(event => event.type === 'tool-call-delta')).toHaveLength(2)
    expect(server.last.json).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('uses json_schema for structured output', async () => {
    server.reply(() => completion({ content: '{"title":"Tea"}' }))
    const { object } = await generateObject({
      model: openai()('gpt-5'),
      schema: v.object({
        title: v.string(),
      }),
      schemaName: 'post',
      prompt: 'x',
    })
    expect(object).toEqual({ title: 'Tea' })
    expect(server.last.json.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'post',
        schema: expect.objectContaining({
          type: 'object',
          required: ['title'],
        }),
      },
    })
  })

  it('throws APICallError with the provider message', async () => {
    server.reply(() => ({
      json: {
        error: { message: 'Invalid API key', type: 'invalid_request_error' },
      },
      status: 401,
    }))
    const error = await generateText({
      model: openai()('gpt-5'),
      prompt: 'x',
    }).catch(error => error)
    expect(error).toBeInstanceOf(APICallError)
    expect(error).toMatchObject({
      status: 401,
      isRetryable: false,
      provider: 'openai',
      message: 'openai API error 401: Invalid API key',
    })
  })
})

describe('openai media endpoints', () => {
  it('embeds, generates images, speech and transcriptions', async () => {
    server.reply((request) => {
      if (request.url === '/embeddings') {
        return {
          json: {
            model: 'text-embedding-3-small',
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
            usage: { prompt_tokens: 4 },
          },
        }
      }
      if (request.url === '/images/generations') {
        return {
          json: {
            data: [
              {
                b64_json: Buffer.from('png-bytes').toString('base64'),
                revised_prompt: 'a cat, digital art',
              },
            ],
          },
        }
      }
      if (request.url === '/audio/speech') {
        return {
          body: new Uint8Array([1, 2, 3]),
          headers: { 'content-type': 'audio/mpeg' },
        }
      }
      return {
        json: {
          text: '你好',
          language: 'zh',
          duration: 1.5,
          segments: [
            { text: '你好', start: 0, end: 1.5 },
          ],
        },
      }
    })
    const provider = openai()
    const { embeddings, usage } = await embedMany({
      model: provider.embeddingModel!('text-embedding-3-small'),
      values: ['a', 'b'],
      dimensions: 2,
    })
    expect(embeddings).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect(usage).toEqual({ tokens: 4 })
    expect(server.last.json).toEqual({
      model: 'text-embedding-3-small',
      input: ['a', 'b'],
      dimensions: 2,
      encoding_format: 'float',
    })

    const { image, revisedPrompts } = await generateImage({
      model: provider.imageModel!('dall-e-3'),
      prompt: 'a cat',
      size: '1024x1024',
    })
    expect(Buffer.from(image.data).toString()).toBe('png-bytes')
    expect(image.mediaType).toBe('image/png')
    expect(revisedPrompts).toEqual(['a cat, digital art'])
    expect(server.last.json).toEqual({
      model: 'dall-e-3',
      prompt: 'a cat',
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    })

    const { audio } = await generateSpeech({
      model: provider.speechModel!('gpt-4o-mini-tts'),
      text: 'Hello',
      voice: 'coral',
    })
    expect([...audio.data]).toEqual([1, 2, 3])
    expect(audio.base64).toBe('AQID')
    expect(server.last.json).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'Hello',
      voice: 'coral',
      response_format: 'mp3',
    })

    const transcript = await transcribe({
      model: provider.transcriptionModel!('whisper-1'),
      audio: new Uint8Array([0x49, 0x44, 0x33, 1]),
      language: 'zh',
    })
    expect(transcript).toEqual({
      text: '你好',
      language: 'zh',
      durationInSeconds: 1.5,
      segments: [
        { text: '你好', start: 0, end: 1.5 },
      ],
    })
    expect(server.last.headers['content-type']).toMatch(/^multipart\/form-data/)
    expect(server.last.body.toString()).toContain('verbose_json')
  })
})

describe('openai-compatible presets', () => {
  it('deepseek: max_tokens, json mode and reasoning_content round trip', async () => {
    server.reply(() => completion({ content: '{"ok":true}', reasoning_content: 'let me think' }))
    const deepseek = createDeepSeek({ baseURL: server.url, apiKey: 'ds-key' })
    const result = await generateText({
      model: deepseek('deepseek-reasoner'),
      messages: [
        { role: 'user', content: 'q1' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'earlier thought' },
            { type: 'text', text: 'a1' },
          ],
        },
        { role: 'user', content: 'q2' },
      ],
      maxOutputTokens: 50,
      reasoning: { effort: 'high' },
    })
    expect(result.reasoningText).toBe('let me think')
    expect(server.last.headers.authorization).toBe('Bearer ds-key')
    expect(server.last.json.max_tokens).toBe(50)
    expect(server.last.json.reasoning_effort).toBeUndefined()
    expect(server.last.json.messages[1]).toEqual({ role: 'assistant', content: 'a1', reasoning_content: 'earlier thought' })

    const { object } = await generateObject({
      model: deepseek('deepseek-chat'),
      schema: v.object({
        ok: v.boolean(),
      }),
      prompt: 'x',
    })
    expect(object).toEqual({ ok: true })
    expect(server.last.json.response_format).toEqual({ type: 'json_object' })
    expect(server.last.json.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('JSON Schema'),
    })
  })

  it('ollama: no auth header, reasoning field', async () => {
    server.reply(() => ({
      sse: [
        {
          choices: [
            {
              index: 0,
              delta: { reasoning: 'hmm ' },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { content: 'done' },
              finish_reason: 'stop',
            },
          ],
        },
        '[DONE]',
      ],
    }))
    const result = streamText({
      model: createOllama({ baseURL: server.url })('qwen3'),
      prompt: 'x',
    })
    expect(await result.text).toBe('done')
    expect(await result.reasoningText).toBe('hmm ')
    expect(server.last.headers.authorization).toBeUndefined()
  })

  it('reports a missing API key clearly', async () => {
    const deepseek = createDeepSeek({ baseURL: server.url })
    const previous = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    await expect(generateText({
      model: deepseek('deepseek-chat'),
      prompt: 'x',
    })).rejects.toThrow('deepseek API key is missing. Pass apiKey or set DEEPSEEK_API_KEY.')
    if (previous)
      process.env.DEEPSEEK_API_KEY = previous
  })
})
