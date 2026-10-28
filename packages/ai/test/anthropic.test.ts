import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { APICallError, defineTool, generateObject, generateText, streamText } from '../src'
import { createAnthropic } from '../src/providers/anthropic'
import { useMockServer } from './server'

const server = useMockServer()
const anthropic = () => createAnthropic({ baseURL: server.url, apiKey: 'sk-ant-test' })

function message(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    json: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason: content.some((block: any) => block.type === 'tool_use')
        ? 'tool_use'
        : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      ...extra,
    },
  }
}

// 1x1 PNG 与 PDF 文件头
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
])
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31])

describe('anthropic messages', () => {
  it('sends headers, system blocks, merged turns, media and options; maps the response', async () => {
    server.reply(() => message([
      { type: 'text', text: 'Hello!' },
    ], {
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    }))
    const result = await generateText({
      model: anthropic()('claude-opus-5-5'),
      system: 'Be kind',
      messages: [
        {
          role: 'system',
          content: 'Long shared context',
          providerOptions: {
            anthropic: {
              cacheControl: { ttl: '1h' },
            },
          },
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            { type: 'image', image: PNG },
            { type: 'image', image: 'https://example.com/cat.png' },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'file',
              data: PDF,
              mediaType: 'application/pdf',
              filename: 'a.pdf',
            },
            {
              type: 'file',
              data: new URL('https://example.com/b.pdf'),
              mediaType: 'application/pdf',
            },
            {
              type: 'file',
              data: new TextEncoder().encode('plain notes'),
              mediaType: 'text/plain',
              providerOptions: {
                anthropic: { cacheControl: true },
              },
            },
          ],
        },
        { role: 'assistant', content: 'Noted.' },
        {
          role: 'user',
          content: 'Summarize',
          providerOptions: {
            anthropic: { cacheControl: true },
          },
        },
      ],
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      stopSequences: ['END'],
      reasoning: { effort: 'minimal', summary: true },
      providerOptions: {
        anthropic: {
          cacheControl: true,
          betas: ['beta-a', 'beta-b'],
          metadata: { user_id: 'u1' },
        },
      },
    })
    expect(result.text).toBe('Hello!')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({
      inputTokens: 130,
      outputTokens: 5,
      totalTokens: 135,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 20,
    })
    expect(result.response).toMatchObject({ id: 'msg_1', modelId: 'claude-opus-5-5' })
    expect(result.warnings).toEqual([
      'temperature is not supported by the Anthropic API (version 2026-10-21) and was ignored',
      'topP is not supported by the Anthropic API (version 2026-10-21) and was ignored',
      'topK is not supported by the Anthropic API (version 2026-10-21) and was ignored',
    ])
    expect(server.last.url).toBe('/messages')
    expect(server.last.headers['x-api-key']).toBe('sk-ant-test')
    expect(server.last.headers.authorization).toBeUndefined()
    expect(server.last.headers['anthropic-version']).toBe('2026-10-21')
    expect(server.last.headers['anthropic-beta']).toBe('beta-a,beta-b')
    expect(server.last.json).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: [
        { type: 'text', text: 'Be kind' },
        {
          type: 'text',
          text: 'Long shared context',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            },
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.com/cat.png' },
            },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
              title: 'a.pdf',
            },
            {
              type: 'document',
              source: { type: 'url', url: 'https://example.com/b.pdf' },
            },
            {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: 'plain notes' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Noted.' },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Summarize',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      stop_sequences: ['END'],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' },
      metadata: { user_id: 'u1' },
    })
  })

  it('maps stop reasons', async () => {
    const model = anthropic()('claude-opus-5-5')
    const cases: Array<[string, string]> = [
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['refusal', 'content-filter'],
      ['pause_turn', 'other'],
    ]
    for (const [stopReason, finishReason] of cases) {
      server.reply(() => message([
        { type: 'text', text: 'x' },
      ], { stop_reason: stopReason }))
      const result = await generateText({ model, prompt: 'x', maxOutputTokens: 10 })
      expect(result.finishReason).toBe(finishReason)
      expect(server.last.json.max_tokens).toBe(10)
    }
  })

  it('runs a tool loop and round-trips thinking signatures and tool results', async () => {
    let call = 0
    server.reply(() => ++call === 1
      ? message([
          { type: 'thinking', thinking: 'Need weather', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'encrypted' },
          { type: 'text', text: 'Checking.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'weather',
            input: { city: 'Paris' },
          },
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'broken',
            input: {},
          },
        ])
      : message([
          { type: 'text', text: 'Sunny' },
        ]))
    const weather = defineTool({
      description: 'Weather',
      parameters: v.object({
        city: v.string(),
      }),
      strict: true,
      execute: () => ({ sky: 'clear' }),
    })
    const broken = defineTool({
      parameters: v.object({}),
      execute: () => {
        throw new Error('boom')
      },
    })
    const result = await generateText({
      model: anthropic()('claude-opus-5-5'),
      prompt: 'Weather?',
      tools: { weather, broken },
      toolChoice: 'auto',
    })
    expect(result.text).toBe('Sunny')
    expect(result.steps[0].finishReason).toBe('tool-calls')
    expect(result.steps[0].reasoningText).toBe('Need weather')
    const first = server.requests[0].json
    expect(first.tools).toEqual([
      {
        name: 'weather',
        description: 'Weather',
        input_schema: expect.objectContaining({
          type: 'object',
          required: ['city'],
          additionalProperties: false,
        }),
        strict: true,
      },
      {
        name: 'broken',
        input_schema: expect.objectContaining({ type: 'object' }),
      },
    ])
    expect(first.tool_choice).toEqual({ type: 'auto' })
    expect(server.requests[1].json.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Weather?' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need weather', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'encrypted' },
          { type: 'text', text: 'Checking.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'weather',
            input: { city: 'Paris' },
          },
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'broken',
            input: {},
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"sky":"clear"}' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: 'boom',
            is_error: true,
          },
        ],
      },
    ])
  })

  it('maps toolChoice', async () => {
    server.reply(() => message([
      { type: 'text', text: 'ok' },
    ]))
    const lookup = defineTool({
      parameters: v.object({
        q: v.string(),
      }),
    })
    const model = anthropic()('claude-opus-5')
    const cases: Array<[Parameters<typeof generateText>[0]['toolChoice'], unknown]> = [
      [
        'none',
        { type: 'none' },
      ],
      [
        'required',
        { type: 'any' },
      ],
      [
        { toolName: 'lookup' },
        { type: 'tool', name: 'lookup' },
      ],
    ]
    for (const [toolChoice, expected] of cases) {
      await generateText({
        model,
        prompt: 'x',
        tools: { lookup },
        toolChoice,
      })
      expect(server.last.json.tool_choice).toEqual(expected)
    }
  })

  it('streams text, thinking with signature and tool calls, then continues the loop', async () => {
    let call = 0
    server.reply(() => ++call === 1
      ? {
          sse: [
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: {
                  id: 'msg_s',
                  model: 'claude-opus-5-5',
                  usage: { input_tokens: 8, cache_read_input_tokens: 2, output_tokens: 1 },
                },
              },
            },
            {
              event: 'ping',
              data: { type: 'ping' },
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '', signature: '' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Let me ' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'think' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'sig-stream' },
              },
            },
            {
              event: 'content_block_stop',
              data: { type: 'content_block_stop', index: 0 },
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'text', text: '' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'text_delta', text: 'Hel' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'text_delta', text: 'lo' },
              },
            },
            {
              event: 'content_block_stop',
              data: { type: 'content_block_stop', index: 1 },
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 2,
                content_block: {
                  type: 'tool_use',
                  id: 'toolu_9',
                  name: 'lookup',
                  input: {},
                },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 2,
                delta: { type: 'input_json_delta', partial_json: '{"q":' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 2,
                delta: { type: 'input_json_delta', partial_json: '"x"}' },
              },
            },
            {
              event: 'content_block_stop',
              data: { type: 'content_block_stop', index: 2 },
            },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use', stop_sequence: null },
                usage: { output_tokens: 30 },
              },
            },
            {
              event: 'message_stop',
              data: { type: 'message_stop' },
            },
          ],
        }
      : {
          sse: [
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: {
                  id: 'msg_t',
                  model: 'claude-opus-5-5',
                  usage: { input_tokens: 50, output_tokens: 1 },
                },
              },
            },
            {
              event: 'content_block_start',
              data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: ' done' },
              },
            },
            {
              event: 'content_block_stop',
              data: { type: 'content_block_stop', index: 0 },
            },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 3 },
              },
            },
            {
              event: 'message_stop',
              data: { type: 'message_stop' },
            },
          ],
        })
    const lookup = defineTool({
      parameters: v.object({
        q: v.string(),
      }),
      execute: ({ q }) => `result for ${q}`,
    })
    const result = streamText({
      model: anthropic()('claude-opus-5-5'),
      prompt: 'x',
      tools: { lookup },
      temperature: 0.5,
    })
    const events = []
    for await (const event of result.fullStream)
      events.push(event)
    expect(await result.text).toBe(' done')
    const steps = await result.steps
    expect(steps[0]).toMatchObject({
      text: 'Hello',
      reasoningText: 'Let me think',
      finishReason: 'tool-calls',
      usage: {
        inputTokens: 10,
        outputTokens: 30,
        totalTokens: 40,
        cachedInputTokens: 2,
      },
      warnings: ['temperature is not supported by the Anthropic API (version 2026-10-21) and was ignored'],
    })
    expect(steps[0].toolCalls).toEqual([
      {
        toolCallId: 'toolu_9',
        toolName: 'lookup',
        input: { q: 'x' },
      },
    ])
    expect(await result.finishReason).toBe('stop')
    expect(events.filter(event => event.type === 'tool-call-delta')).toHaveLength(2)
    expect(events.filter(event => event.type === 'reasoning-delta')).toHaveLength(2)
    const first = server.requests[0].json
    expect(first).toMatchObject({ stream: true, max_tokens: 64000 })
    expect(first.temperature).toBeUndefined()
    expect(server.requests[1].json.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think', signature: 'sig-stream' },
          { type: 'text', text: 'Hello' },
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'lookup',
            input: { q: 'x' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_9', content: 'result for x' },
        ],
      },
    ])
  })

  it('uses output_config.format for structured output', async () => {
    server.reply(() => message([
      { type: 'text', text: '{"title":"Tea"}' },
    ]))
    const { object } = await generateObject({
      model: anthropic()('claude-opus-5-5'),
      schema: v.object({
        title: v.string(),
      }),
      prompt: 'x',
      reasoning: { effort: 'high' },
    })
    expect(object).toEqual({ title: 'Tea' })
    expect(server.last.json.output_config).toEqual({
      effort: 'high',
      format: {
        type: 'json_schema',
        schema: expect.objectContaining({
          type: 'object',
          required: ['title'],
          additionalProperties: false,
        }),
      },
    })
    expect(server.last.json.system).toBeUndefined()
  })

  it('surfaces stream error events', async () => {
    server.reply(() => ({
      sse: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: {
              id: 'msg_e',
              model: 'claude-opus-5-5',
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
        },
        {
          event: 'error',
          data: {
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
          },
        },
      ],
    }))
    const result = streamText({
      model: anthropic()('claude-opus-5-5'),
      prompt: 'x',
    })
    const error = await result.text.catch(error => error)
    expect(error).toBeInstanceOf(APICallError)
    expect(error).toMatchObject({ message: 'anthropic stream error: Overloaded', isRetryable: true })
  })

  it('throws APICallError with the provider message', async () => {
    server.reply(() => ({
      json: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens: field required' },
      },
      status: 400,
    }))
    const error = await generateText({
      model: anthropic()('claude-opus-5-5'),
      prompt: 'x',
    }).catch(error => error)
    expect(error).toBeInstanceOf(APICallError)
    expect(error).toMatchObject({
      status: 400,
      isRetryable: false,
      provider: 'anthropic',
      message: 'anthropic API error 400: max_tokens: field required',
    })
  })

  it('supports bearer auth tokens and reports a missing key', async () => {
    server.reply(() => message([
      { type: 'text', text: 'ok' },
    ]))
    await generateText({
      model: createAnthropic({ baseURL: server.url, authToken: 'oauth-token' })('claude-opus-5-5'),
      prompt: 'x',
    })
    expect(server.last.headers.authorization).toBe('Bearer oauth-token')
    expect(server.last.headers['x-api-key']).toBeUndefined()

    const previous = [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN]
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    try {
      await expect(generateText({
        model: createAnthropic({ baseURL: server.url })('claude-opus-5-5'),
        prompt: 'x',
      })).rejects.toThrow('Anthropic API key is missing. Pass apiKey or set ANTHROPIC_API_KEY.')
      process.env.ANTHROPIC_AUTH_TOKEN = 'env-token'
      await generateText({
        model: createAnthropic({ baseURL: server.url })('claude-opus-5-5'),
        prompt: 'x',
      })
      expect(server.last.headers.authorization).toBe('Bearer env-token')
    }
    finally {
      delete process.env.ANTHROPIC_AUTH_TOKEN
      if (previous[0])
        process.env.ANTHROPIC_API_KEY = previous[0]
      if (previous[1])
        process.env.ANTHROPIC_AUTH_TOKEN = previous[1]
    }
  })
})
