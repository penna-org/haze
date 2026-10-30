import { Buffer } from 'node:buffer'
import * as v from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineTool, embedMany, generateImage, generateObject, generateText, streamText } from '../src'
import { canonicalRequest, createBedrock, signAwsRequest } from '../src/providers/bedrock'
import { useMockServer } from './server'

const server = useMockServer()
const keys = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
function bedrock(extra: Parameters<typeof createBedrock>[0] = {}) {
  return createBedrock({
    baseURL: server.url,
    region: 'us-west-2',
    ...keys,
    ...extra,
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

// --- 测试用的 event stream 编码器（独立实现的 CRC32） ---

function crc32(bytes: Uint8Array): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function frame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const headerBytes: number[] = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = Buffer.from(name)
    const valueBytes = Buffer.from(value)
    headerBytes.push(nameBytes.length, ...nameBytes, 7, valueBytes.length >> 8, valueBytes.length & 0xFF, ...valueBytes)
  }
  const total = 12 + headerBytes.length + payload.length + 4
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headerBytes.length)
  view.setUint32(8, crc32(bytes.subarray(0, 8)))
  bytes.set(headerBytes, 12)
  bytes.set(payload, 12 + headerBytes.length)
  view.setUint32(total - 4, crc32(bytes.subarray(0, total - 4)))
  return bytes
}

function event(type: string, body: unknown): Uint8Array {
  return frame({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, Buffer.from(JSON.stringify(body)))
}

function concat(frames: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(frames))
}

function eventStream(frames: Uint8Array[]) {
  return {
    body: concat(frames),
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  }
}

function converse(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    json: {
      output: {
        message: { role: 'assistant', content },
      },
      stopReason: 'end_turn',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 20,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
      },
      metrics: { latencyMs: 100 },
      ...extra,
    },
  }
}

describe('sigv4', () => {
  const date = new Date('2015-08-30T12:36:00Z')

  it('matches the AWS SigV4 test suite (get-vanilla)', async () => {
    const headers = await signAwsRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      credentials: keys,
      region: 'us-east-1',
      service: 'service',
      date,
    })
    expect(headers['x-amz-date']).toBe('20150830T123600Z')
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  })

  it('matches the documented IAM ListUsers example (query string, content-type)', async () => {
    const headers = await signAwsRequest({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Version=2010-05-08&Action=ListUsers',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      credentials: keys,
      region: 'us-east-1',
      service: 'iam',
      date,
    })
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7')
  })

  it('double-encodes path segments and sorts headers in the canonical request', () => {
    const { request, signedHeaders } = canonicalRequest('post', new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v2%3A1/converse?b=2&a=x%20y'), {
      'x-amz-date': '20150830T123600Z',
      'host': 'bedrock-runtime.us-east-1.amazonaws.com',
      'content-type': ' application/json  ',
    }, 'abc')
    expect(signedHeaders).toBe('content-type;host;x-amz-date')
    expect(request).toBe([
      'POST',
      '/model/anthropic.claude-v2%253A1/converse',
      'a=x%20y&b=2',
      'content-type:application/json',
      'host:bedrock-runtime.us-east-1.amazonaws.com',
      'x-amz-date:20150830T123600Z',
      '',
      'content-type;host;x-amz-date',
      'abc',
    ].join('\n'))
  })

  it('is deterministic and signs the session token and content hash', async () => {
    const options = {
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/x/converse',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      credentials: { ...keys, sessionToken: 'session' },
      region: 'us-east-1',
      service: 'bedrock',
      date,
      signContentSha256: true,
    }
    const first = await signAwsRequest(options)
    expect(await signAwsRequest(options)).toEqual(first)
    expect(first['x-amz-security-token']).toBe('session')
    expect(first['x-amz-content-sha256']).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862')
    expect(first.authorization).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,')
    const changed = await signAwsRequest({ ...options, body: '{"a":2}' })
    expect(changed.authorization).not.toBe(first.authorization)
  })
})

describe('bedrock converse', () => {
  it('signs requests with SigV4 and maps the request and response', async () => {
    server.reply(() => converse([
      { text: 'Hello!' },
    ]))
    const result = await generateText({
      model: bedrock({ sessionToken: 'tok' })('anthropic.claude-3-haiku-20240307-v1:0'),
      system: 'Be kind',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            {
              type: 'image',
              image: new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2]),
            },
            {
              type: 'file',
              data: Buffer.from('%PDF-1.4').toString('base64'),
              mediaType: 'application/pdf',
              filename: 'report_2024.v1.pdf',
            },
          ],
        },
      ],
      maxOutputTokens: 100,
      temperature: 0.3,
      topP: 0.9,
      topK: 40,
      stopSequences: ['END'],
      providerOptions: {
        bedrock: {
          guardrailConfig: { guardrailIdentifier: 'g1', guardrailVersion: '1' },
          anthropic_beta: ['x'],
        },
      },
    })
    expect(result.text).toBe('Hello!')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({
      inputTokens: 15,
      outputTokens: 5,
      totalTokens: 20,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 2,
    })
    expect(server.last.url).toBe('/model/anthropic.claude-3-haiku-20240307-v1%3A0/converse')
    const headers = server.last.headers
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/)
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
    expect(headers['x-amz-security-token']).toBe('tok')
    expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(server.last.json).toEqual({
      messages: [
        {
          role: 'user',
          content: [
            { text: 'Look' },
            {
              image: {
                format: 'png',
                source: {
                  bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2]).toString('base64'),
                },
              },
            },
            {
              document: {
                format: 'pdf',
                name: 'report-2024-v1',
                source: {
                  bytes: Buffer.from('%PDF-1.4').toString('base64'),
                },
              },
            },
          ],
        },
      ],
      system: [
        { text: 'Be kind' },
      ],
      inferenceConfig: {
        maxTokens: 100,
        temperature: 0.3,
        topP: 0.9,
        stopSequences: ['END'],
      },
      additionalModelRequestFields: {
        anthropic_beta: ['x'],
        top_k: 40,
      },
      guardrailConfig: { guardrailIdentifier: 'g1', guardrailVersion: '1' },
    })
  })

  it('uses a Bedrock API key as a bearer token', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'bedrock-api-key')
    server.reply(() => converse([
      { text: 'ok' },
    ]))
    await generateText({
      model: createBedrock({ baseURL: server.url })('amazon.nova-pro-v1:0'),
      prompt: 'x',
    })
    expect(server.last.headers.authorization).toBe('Bearer bedrock-api-key')
    expect(server.last.headers['x-amz-date']).toBeUndefined()
  })

  it('builds the regional endpoint and reports missing credentials', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '')
    vi.stubEnv('AWS_ACCESS_KEY_ID', '')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', '')
    const urls: string[] = []
    const model = createBedrock({
      region: 'eu-central-1',
      fetch: async (url) => {
        urls.push(String(url))
        return new Response('{}')
      },
    })('m')
    await expect(generateText({ model, prompt: 'x', maxRetries: 0 })).rejects.toThrow(/credentials are missing/)
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKID')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret')
    await generateText({ model, prompt: 'x' })
    expect(urls).toEqual(['https://bedrock-runtime.eu-central-1.amazonaws.com/model/m/converse'])
  })

  it('uses adaptive thinking with effort for current Claude models', async () => {
    server.reply(() => converse([
      { text: 'ok' },
    ]))
    await generateText({
      model: bedrock()('us.anthropic.claude-opus-5-5'),
      prompt: 'x',
      reasoning: { effort: 'minimal', summary: true },
      maxOutputTokens: 500,
    })
    expect(server.last.json.additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    })
    expect(server.last.json.inferenceConfig.maxTokens).toBe(500)
  })

  it('round-trips reasoning signatures and maps reasoning effort to thinking', async () => {
    let call = 0
    server.reply(() => ++call === 1
      ? converse([
          {
            reasoningContent: {
              reasoningText: { text: 'Let me think', signature: 'sig-123' },
            },
          },
          {
            reasoningContent: { redactedContent: 'cmVkYWN0ZWQ=' },
          },
          {
            toolUse: {
              toolUseId: 'tu_1',
              name: 'weather',
              input: { city: 'Paris' },
            },
          },
        ], { stopReason: 'tool_use' })
      : converse([
          { text: 'Sunny' },
        ]))
    const weather = defineTool({
      description: 'Weather',
      parameters: v.object({
        city: v.string(),
      }),
      execute: () => ({ sky: 'clear' }),
    })
    const result = await generateText({
      model: bedrock()('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
      prompt: 'Weather?',
      tools: { weather },
      reasoning: { effort: 'low' },
      maxOutputTokens: 1000,
    })
    expect(result.text).toBe('Sunny')
    const first = server.requests[0].json
    expect(first.additionalModelRequestFields).toEqual({
      thinking: { type: 'enabled', budget_tokens: 2048 },
    })
    expect(first.inferenceConfig.maxTokens).toBe(3048)
    expect(first.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'weather',
            description: 'Weather',
            inputSchema: {
              json: expect.objectContaining({ type: 'object' }),
            },
          },
        },
      ],
    })
    expect(server.requests[1].json.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            reasoningContent: {
              reasoningText: { text: 'Let me think', signature: 'sig-123' },
            },
          },
          {
            reasoningContent: { redactedContent: 'cmVkYWN0ZWQ=' },
          },
          {
            toolUse: {
              toolUseId: 'tu_1',
              name: 'weather',
              input: { city: 'Paris' },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'tu_1',
              content: [
                {
                  json: { sky: 'clear' },
                },
              ],
            },
          },
        ],
      },
    ])
    expect(result.steps[0].content[0]).toEqual({
      type: 'reasoning',
      text: 'Let me think',
      providerMetadata: {
        bedrock: { signature: 'sig-123' },
      },
    })
  })

  it('maps tool choice, error results and merges consecutive messages', async () => {
    server.reply(() => converse([
      { text: 'done' },
    ], { stopReason: 'max_tokens' }))
    const result = await generateText({
      model: bedrock()('amazon.nova-lite-v1:0'),
      messages: [
        { role: 'user', content: 'a' },
        {
          role: 'user',
          content: 'b',
          providerOptions: {
            bedrock: { cachePoint: true },
          },
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'f',
              input: '{"q":1}',
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 't1',
              toolName: 'f',
              output: 'boom',
              isError: true,
            },
          ],
        },
      ],
      tools: {
        f: defineTool({
          description: 'F',
          parameters: v.object({
            q: v.number(),
          }),
        }),
      },
      toolChoice: { toolName: 'f' },
      reasoning: { effort: 'high' },
    })
    expect(result.finishReason).toBe('length')
    const body = server.last.json
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { text: 'a' },
          { text: 'b' },
          {
            cachePoint: { type: 'default' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 't1',
              name: 'f',
              input: { q: 1 },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 't1',
              content: [
                { text: 'boom' },
              ],
              status: 'error',
            },
          },
        ],
      },
    ])
    expect(body.toolConfig.toolChoice).toEqual({
      tool: { name: 'f' },
    })
    expect(body.additionalModelRequestFields).toEqual({
      reasoningConfig: { type: 'enabled', maxReasoningEffort: 'high' },
    })
  })

  it('uses a tool for structured output by default and outputConfig in native mode', async () => {
    server.reply(() => converse([
      {
        toolUse: {
          toolUseId: 'j',
          name: 'json',
          input: { name: 'Ada' },
        },
      },
    ], { stopReason: 'tool_use' }))
    const schema = v.object({
      name: v.string(),
    })
    const { object } = await generateObject({
      model: bedrock()('anthropic.claude-3-haiku-20240307-v1:0'),
      schema,
      prompt: 'x',
    })
    expect(object).toEqual({ name: 'Ada' })
    expect(server.last.json.toolConfig.toolChoice).toEqual({
      tool: { name: server.last.json.toolConfig.tools[0].toolSpec.name },
    })

    server.reply(() => converse([
      { text: '{"name":"Bob"}' },
    ]))
    const native = await generateObject({
      model: bedrock()('amazon.nova-pro-v1:0'),
      schema,
      schemaName: 'person',
      prompt: 'x',
      mode: 'native',
    })
    expect(native.object).toEqual({ name: 'Bob' })
    const textFormat = server.last.json.outputConfig.textFormat
    expect(textFormat.type).toBe('json_schema')
    expect(textFormat.structure.jsonSchema.name).toBe('person')
    expect(JSON.parse(textFormat.structure.jsonSchema.schema)).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    })
  })

  it('throws APICallError with the Bedrock message', async () => {
    server.reply(() => ({
      json: { message: 'The provided model identifier is invalid.' },
      status: 400,
    }))
    await expect(generateText({
      model: bedrock()('nope'),
      prompt: 'x',
    })).rejects.toThrow(/bedrock API error 400: The provided model identifier is invalid/)
  })
})

describe('bedrock converse-stream', () => {
  it('decodes event-stream frames into text, reasoning, tool calls and usage', async () => {
    let call = 0
    server.reply(() => ++call === 1
      ? eventStream([
          event('messageStart', { role: 'assistant' }),
          event('contentBlockDelta', {
            contentBlockIndex: 0,
            delta: {
              reasoningContent: { text: 'Think' },
            },
          }),
          event('contentBlockDelta', {
            contentBlockIndex: 0,
            delta: {
              reasoningContent: { text: 'ing' },
            },
          }),
          event('contentBlockDelta', {
            contentBlockIndex: 0,
            delta: {
              reasoningContent: { signature: 'sig-s' },
            },
          }),
          event('contentBlockStop', { contentBlockIndex: 0 }),
          event('contentBlockDelta', {
            contentBlockIndex: 1,
            delta: { text: 'Let me ' },
          }),
          event('contentBlockDelta', {
            contentBlockIndex: 1,
            delta: { text: 'check.' },
          }),
          event('contentBlockStop', { contentBlockIndex: 1 }),
          event('contentBlockStart', {
            contentBlockIndex: 2,
            start: {
              toolUse: { toolUseId: 'tu_9', name: 'lookup' },
            },
          }),
          event('contentBlockDelta', {
            contentBlockIndex: 2,
            delta: {
              toolUse: { input: '{"q":' },
            },
          }),
          event('contentBlockDelta', {
            contentBlockIndex: 2,
            delta: {
              toolUse: { input: '"x"}' },
            },
          }),
          event('contentBlockStop', { contentBlockIndex: 2 }),
          event('messageStop', { stopReason: 'tool_use' }),
          event('metadata', {
            usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
            metrics: { latencyMs: 5 },
          }),
        ])
      : eventStream([
          event('messageStart', { role: 'assistant' }),
          event('contentBlockDelta', {
            contentBlockIndex: 0,
            delta: { text: 'Found it' },
          }),
          event('contentBlockStop', { contentBlockIndex: 0 }),
          event('messageStop', { stopReason: 'end_turn' }),
          event('metadata', {
            usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
          }),
        ]))
    const lookup = defineTool({
      description: 'Lookup',
      parameters: v.object({
        q: v.string(),
      }),
      execute: ({ q }) => `result for ${q}`,
    })
    const result = streamText({
      model: bedrock()('anthropic.claude-3-7-sonnet-20250219-v1:0'),
      prompt: 'Find x',
      tools: { lookup },
    })
    const deltas: string[] = []
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta')
        deltas.push(part.text)
    }
    expect(deltas).toEqual(['Let me ', 'check.', 'Found it'])
    expect(await result.text).toBe('Found it')
    expect(server.requests[0].url).toBe('/model/anthropic.claude-3-7-sonnet-20250219-v1%3A0/converse-stream')
    const steps = await result.steps
    expect(steps[0].finishReason).toBe('tool-calls')
    expect(steps[0].usage).toEqual({ inputTokens: 8, outputTokens: 4, totalTokens: 12 })
    expect(steps[0].content).toEqual([
      {
        type: 'reasoning',
        text: 'Thinking',
        providerMetadata: {
          bedrock: { signature: 'sig-s' },
        },
      },
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool-call',
        toolCallId: 'tu_9',
        toolName: 'lookup',
        input: { q: 'x' },
      },
    ])
    expect(server.requests[1].json.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            reasoningContent: {
              reasoningText: { text: 'Thinking', signature: 'sig-s' },
            },
          },
          { text: 'Let me check.' },
          {
            toolUse: {
              toolUseId: 'tu_9',
              name: 'lookup',
              input: { q: 'x' },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'tu_9',
              content: [
                { text: 'result for x' },
              ],
            },
          },
        ],
      },
    ])
  })

  it('handles frames split across network chunks', async () => {
    const bytes = concat([
      event('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { text: 'A' },
      }),
      event('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { text: 'B' },
      }),
      event('messageStop', { stopReason: 'end_turn' }),
    ])
    const model = createBedrock({
      apiKey: 'k',
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          // 每次 7 字节，帧边界与网络块不对齐
          for (let offset = 0; offset < bytes.length; offset += 7)
            controller.enqueue(bytes.slice(offset, offset + 7))
          controller.close()
        },
      })),
    })('m')
    expect(await streamText({ model, prompt: 'x' }).text).toBe('AB')
  })

  it('rejects a frame with a corrupted checksum', async () => {
    const good = event('contentBlockDelta', {
      contentBlockIndex: 0,
      delta: { text: 'A' },
    })
    const bad = event('contentBlockDelta', {
      contentBlockIndex: 0,
      delta: { text: 'B' },
    })
    bad[bad.length - 10] ^= 0xFF
    server.reply(() => eventStream([good, bad]))
    const result = streamText({
      model: bedrock()('m'),
      prompt: 'x',
      maxRetries: 0,
    })
    await expect(result.text).rejects.toThrow(/checksum mismatch/)

    const prelude = event('messageStop', { stopReason: 'end_turn' })
    prelude[9] ^= 0xFF
    server.reply(() => eventStream([prelude]))
    await expect(streamText({
      model: bedrock()('m'),
      prompt: 'x',
    }).text).rejects.toThrow(/prelude checksum mismatch/)
  })

  it('surfaces exception frames as errors', async () => {
    server.reply(() => eventStream([
      event('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { text: 'A' },
      }),
      frame({ ':exception-type': 'throttlingException', ':content-type': 'application/json', ':message-type': 'exception' }, Buffer.from(JSON.stringify({ message: 'Too many requests' }))),
    ]))
    await expect(streamText({
      model: bedrock()('m'),
      prompt: 'x',
    }).text).rejects.toMatchObject({
      message: expect.stringContaining('throttlingException: Too many requests'),
      isRetryable: true,
    })
  })
})

describe('bedrock invoke models', () => {
  it('embeds Titan values one per call', async () => {
    server.reply(request => ({
      json: {
        embedding: [request.json.inputText.length, 0],
        inputTextTokenCount: 2,
      },
    }))
    const { embeddings, usage } = await embedMany({
      model: bedrock().embeddingModel!('amazon.titan-embed-text-v2:0'),
      values: ['a', 'bb', 'ccc'],
      dimensions: 256,
    })
    expect(embeddings).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ])
    expect(usage).toEqual({ tokens: 6 })
    expect(server.requests).toHaveLength(3)
    expect(server.requests[0].url).toBe('/model/amazon.titan-embed-text-v2%3A0/invoke')
    // 三次调用并发发出，到达顺序不固定
    expect(server.requests.map(request => request.json.inputText).sort()).toEqual(['a', 'bb', 'ccc'])
    expect(server.requests[1].json).toMatchObject({ dimensions: 256, normalize: true })
  })

  it('embeds Cohere values in one batch', async () => {
    server.reply(() => ({
      json: {
        id: 'e',
        embeddings: [
          [1],
          [2],
        ],
        texts: ['a', 'b'],
      },
    }))
    const { embeddings } = await embedMany({
      model: bedrock().embeddingModel!('cohere.embed-multilingual-v3'),
      values: ['a', 'b'],
      providerOptions: {
        bedrock: { input_type: 'search_query' },
      },
    })
    expect(embeddings).toEqual([
      [1],
      [2],
    ])
    expect(server.requests).toHaveLength(1)
    expect(server.last.json).toEqual({
      texts: ['a', 'b'],
      input_type: 'search_query',
    })

    server.reply(() => ({
      json: {
        embeddings: {
          float: [
            [3],
          ],
        },
      },
    }))
    const v4 = await embedMany({
      model: bedrock().embeddingModel!('cohere.embed-v4:0'),
      values: ['c'],
    })
    expect(v4.embeddings).toEqual([
      [3],
    ])
  })

  it('generates Nova Canvas images', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 9]).toString('base64')
    server.reply(() => ({
      json: {
        images: [png, png],
      },
    }))
    const { images } = await generateImage({
      model: bedrock().imageModel!('amazon.nova-canvas-v1:0'),
      prompt: 'A cat',
      n: 2,
      size: '512x512',
      seed: 7,
    })
    expect(images).toHaveLength(2)
    expect(images[0].mediaType).toBe('image/png')
    expect(images[0].base64).toBe(png)
    expect(server.last.json).toEqual({
      taskType: 'TEXT_IMAGE',
      textToImageParams: { text: 'A cat' },
      imageGenerationConfig: {
        numberOfImages: 2,
        width: 512,
        height: 512,
        seed: 7,
      },
    })
  })
})
