import type { EmbeddingModel } from '../src'
import * as v from 'valibot'
import { afterEach, describe, expect, it } from 'vitest'
import { APICallError, configureAI, cosineSimilarity, createProvider, defineTool, embedMany, generateObject, generateText, jsonSchema, mockModel, NoObjectGeneratedError, NoSuchModelError, parsePartialJSON, parseSSE, setModelRegistry, streamObject, streamText, withRetry } from '../src'

afterEach(() => setModelRegistry(undefined))

const weather = defineTool({
  description: 'Get the weather of a city',
  parameters: v.object({
    city: v.string(),
  }),
  execute: async ({ city }) => ({ city, temperature: 21 }),
})

describe('generateText', () => {
  it('returns text, usage and response messages', async () => {
    const model = mockModel('Hello there')
    const result = await generateText({ model, system: 'Be brief', prompt: 'Hi' })
    expect(result.text).toBe('Hello there')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(model.requests[0].messages).toEqual([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'Hi' },
    ])
    expect(result.response.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello there' },
        ],
      },
    ])
  })

  it('runs tools in a loop and feeds results back to the model', async () => {
    const model = mockModel([
      {
        toolCalls: [
          {
            toolName: 'weather',
            input: { city: 'Paris' },
            toolCallId: 'c1',
          },
        ],
      },
      'It is 21°C in Paris.',
    ])
    const steps: number[] = []
    const result = await generateText({
      model,
      prompt: 'Weather in Paris?',
      tools: { weather },
      onStepFinish: step => void steps.push(step.stepNumber),
    })
    expect(result.text).toBe('It is 21°C in Paris.')
    expect(result.steps).toHaveLength(2)
    expect(steps).toEqual([0, 1])
    expect(result.steps[0].toolResults).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'weather',
        input: { city: 'Paris' },
        output: { city: 'Paris', temperature: 21 },
      },
    ])
    // 工具声明转换为 JSON Schema
    expect(model.requests[0].tools).toEqual([
      {
        name: 'weather',
        description: 'Get the weather of a city',
        parameters: expect.objectContaining({
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
        }),
      },
    ])
    // 第二次请求带上了工具调用与结果
    expect(model.requests[1].messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'weather',
            input: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'weather',
            output: { city: 'Paris', temperature: 21 },
          },
        ],
      },
    ])
    expect(result.totalUsage.totalTokens).toBe(30)
  })

  it('reports invalid tool input back to the model instead of executing', async () => {
    let executed = false
    const strictTool = defineTool({
      parameters: v.object({
        count: v.number(),
      }),
      execute: () => (executed = true),
    })
    const model = mockModel([
      {
        toolCalls: [
          {
            toolName: 'count',
            input: { count: 'many' },
          },
        ],
      },
      'Sorry',
    ])
    const result = await generateText({
      model,
      prompt: 'x',
      tools: { count: strictTool },
    })
    expect(executed).toBe(false)
    expect(result.steps[0].toolResults[0]).toMatchObject({
      isError: true,
      output: expect.stringContaining('Invalid arguments for tool "count"'),
    })
    expect(result.text).toBe('Sorry')
  })

  it('stops when a tool has no execute (client-side tools) and respects maxSteps', async () => {
    const confirm = defineTool({
      description: 'Ask the user',
      parameters: jsonSchema({ type: 'object', properties: {} }),
    })
    const model = mockModel([
      {
        toolCalls: [
          { toolName: 'confirm', input: {} },
        ],
      },
      'never',
    ])
    const result = await generateText({
      model,
      prompt: 'x',
      tools: { confirm },
    })
    expect(result.steps).toHaveLength(1)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolResults).toEqual([])

    const looping = mockModel({
      toolCalls: [
        {
          toolName: 'weather',
          input: { city: 'Rome' },
        },
      ],
    })
    const limited = await generateText({
      model: looping,
      prompt: 'x',
      tools: { weather },
      maxSteps: 3,
    })
    expect(limited.steps).toHaveLength(3)
  })

  it('turns tool exceptions into error results', async () => {
    const failing = defineTool({
      parameters: v.object({}),
      execute: () => {
        throw new Error('service down')
      },
    })
    const model = mockModel([
      {
        toolCalls: [
          { toolName: 'failing', input: {} },
        ],
      },
      'fallback',
    ])
    const result = await generateText({
      model,
      prompt: 'x',
      tools: { failing },
    })
    expect(result.steps[0].toolResults[0]).toMatchObject({ output: 'service down', isError: true })
  })
})

describe('streamText', () => {
  it('streams text and tool events to several consumers', async () => {
    const model = mockModel([
      {
        reasoning: 'thinking',
        toolCalls: [
          {
            toolName: 'weather',
            input: { city: 'Paris' },
            toolCallId: 'c1',
          },
        ],
      },
      'Sunny and warm',
    ])
    const result = streamText({
      model,
      prompt: 'x',
      tools: { weather },
    })
    const chunks: string[] = []
    for await (const chunk of result.textStream)
      chunks.push(chunk)
    expect(chunks.join('')).toBe('Sunny and warm')
    expect(await result.text).toBe('Sunny and warm')
    expect((await result.steps).length).toBe(2)
    const types: string[] = []
    for await (const event of result.fullStream)
      types.push(event.type)
    expect(types).toEqual([
      'start',
      'start-step',
      'reasoning-delta',
      'tool-call-start',
      'tool-call-delta',
      'tool-call',
      'tool-result',
      'finish-step',
      'start-step',
      'text-delta',
      'text-delta',
      'text-delta',
      'finish-step',
      'finish',
    ])
    // 推理内容（含 reasoning-end）进入回传的消息
    const [assistant] = (await result.response).messages
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', toolName: 'weather' },
      ],
    })
  })

  it('keeps the signature of each reasoning block (redacted blocks get their own part)', async () => {
    const model = mockModel('x')
    model.stream = async () => new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'reasoning-delta', text: 'step one' })
        controller.enqueue({
          type: 'reasoning-end',
          providerMetadata: {
            anthropic: { signature: 'sig-1' },
          },
        })
        controller.enqueue({
          type: 'reasoning-end',
          providerMetadata: {
            anthropic: { redactedData: 'opaque' },
          },
        })
        controller.enqueue({ type: 'text-delta', text: 'answer' })
        controller.enqueue({
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        })
        controller.close()
      },
    })
    const result = streamText({ model, prompt: 'x' })
    const [assistant] = (await result.response).messages
    expect(assistant.content).toEqual([
      {
        type: 'reasoning',
        text: 'step one',
        providerMetadata: {
          anthropic: { signature: 'sig-1' },
        },
      },
      {
        type: 'reasoning',
        text: '',
        providerMetadata: {
          anthropic: { redactedData: 'opaque' },
        },
      },
      { type: 'text', text: 'answer' },
    ])
  })

  it('encodes the hazejs SSE protocol in toResponse()', async () => {
    const response = streamText({
      model: mockModel('Hi there'),
      prompt: 'x',
    }).toResponse()
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(response.headers.get('x-hazejs-ai-stream')).toBe('v1')
    const events: Array<{ event?: string, data: unknown }> = []
    for await (const event of parseSSE(response.body!)) {
      events.push({
        event: event.event,
        data: JSON.parse(event.data),
      })
    }
    expect(events.map(event => event.event)).toEqual([
      'start',
      'text',
      'text',
      'step',
      'finish',
      'done',
    ])
    expect(events[1].data).toEqual({ delta: 'Hi ' })
    expect(events[4].data).toMatchObject({
      finishReason: 'stop',
      usage: { totalTokens: 15 },
    })
  })

  it('streams plain text with toTextStreamResponse()', async () => {
    const response = streamText({
      model: mockModel('plain text'),
      prompt: 'x',
    }).toTextStreamResponse()
    expect(await response.text()).toBe('plain text')
  })

  it('surfaces errors as error events and rejected promises', async () => {
    const model = mockModel('x')
    model.stream = async () => {
      throw new Error('boom')
    }
    const errors: unknown[] = []
    const result = streamText({
      model,
      prompt: 'x',
      maxRetries: 0,
      onError: error => void errors.push(error),
    })
    await expect(result.text).rejects.toThrow('boom')
    const events = []
    for await (const event of result.fullStream)
      events.push(event.type)
    expect(events).toEqual(['start', 'start-step', 'error'])
    expect(errors).toHaveLength(1)
  })
})

describe('structured output', () => {
  const Recipe = v.object({
    name: v.string(),
    steps: v.array(v.string()),
  })

  it('generates validated objects in native, json and tool modes', async () => {
    const native = mockModel('{"name":"Tea","steps":["boil","steep"]}')
    expect((await generateObject({ model: native, schema: Recipe, prompt: 'x' })).object).toEqual({
      name: 'Tea',
      steps: ['boil', 'steep'],
    })
    expect(native.requests[0].responseFormat).toMatchObject({
      type: 'json',
      name: 'response',
      schema: expect.objectContaining({ type: 'object' }),
    })

    const json = mockModel('```json\n{"name":"Tea","steps":[]}\n```', { structuredOutput: 'json' })
    expect((await generateObject({ model: json, schema: Recipe, prompt: 'x' })).object).toEqual({ name: 'Tea', steps: [] })
    expect(json.requests[0].messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('JSON Schema'),
    })
    expect(json.requests[0].responseFormat).toEqual({ type: 'json', name: 'response' })

    const tool = mockModel({
      toolCalls: [
        {
          toolName: 'json',
          input: {
            name: 'Tea',
            steps: ['a'],
          },
        },
      ],
    }, { structuredOutput: 'tool' })
    expect((await generateObject({ model: tool, schema: Recipe, prompt: 'x' })).object).toEqual({
      name: 'Tea',
      steps: ['a'],
    })
    expect(tool.requests[0].toolChoice).toEqual({ toolName: 'json' })
  })

  it('rejects output that does not match the schema', async () => {
    await expect(generateObject({
      model: mockModel('{"name":1}'),
      schema: Recipe,
      prompt: 'x',
    })).rejects.toBeInstanceOf(NoObjectGeneratedError)
    await expect(generateObject({
      model: mockModel('not json'),
      schema: Recipe,
      prompt: 'x',
    })).rejects.toThrow('not valid JSON')
  })

  it('parses partial JSON while streaming', async () => {
    expect(parsePartialJSON('{"name":"Te')).toEqual({ name: 'Te' })
    expect(parsePartialJSON('{"name":"Tea","steps":["boil",')).toEqual({
      name: 'Tea',
      steps: ['boil'],
    })
    expect(parsePartialJSON('{"name":"Tea","ste')).toEqual({ name: 'Tea' })
    expect(parsePartialJSON('')).toBeUndefined()

    const result = streamObject({
      model: mockModel('{"name": "Tea", "steps": ["boil", "steep"]}'),
      schema: Recipe,
      prompt: 'x',
    })
    const partials = []
    for await (const partial of result.partialObjectStream)
      partials.push(partial)
    expect(partials.length).toBeGreaterThan(1)
    expect(partials.at(-1)).toEqual({
      name: 'Tea',
      steps: ['boil', 'steep'],
    })
    expect(await result.object).toEqual({
      name: 'Tea',
      steps: ['boil', 'steep'],
    })
  })
})

describe('model registry, embeddings and retries', () => {
  it('resolves provider:model strings, aliases and defaults', async () => {
    const created: string[] = []
    const provider = createProvider('mock', {
      languageModel: (id) => {
        created.push(id)
        return mockModel(`from ${id}`)
      },
    })
    configureAI({
      providers: { mock: provider },
      aliases: { fast: 'mock:small' },
      defaults: { language: 'mock:large' },
    })
    expect((await generateText({ model: 'mock:medium', prompt: 'x' })).text).toBe('from medium')
    expect((await generateText({ model: 'fast', prompt: 'x' })).text).toBe('from small')
    expect((await generateText({ prompt: 'x' })).text).toBe('from large')
    await expect(generateText({ model: 'other:x', prompt: 'x' })).rejects.toBeInstanceOf(NoSuchModelError)
    provider('direct')
    expect(created).toEqual(['medium', 'small', 'large', 'direct'])
  })

  it('batches embeddings by the model limit and keeps order', async () => {
    const calls: string[][] = []
    const model: EmbeddingModel = {
      kind: 'embedding',
      provider: 'mock',
      modelId: 'mock',
      maxBatchSize: 2,
      async embed({ values }) {
        calls.push(values)
        return {
          embeddings: values.map(value => [value.length, 1]),
          usage: { tokens: values.length },
        }
      },
    }
    const { embeddings, usage } = await embedMany({
      model,
      values: ['a', 'bb', 'ccc', 'dddd', 'eeeee'],
    })
    expect(calls).toEqual([
      ['a', 'bb'],
      ['ccc', 'dddd'],
      ['eeeee'],
    ])
    expect(embeddings.map(vector => vector[0])).toEqual([1, 2, 3, 4, 5])
    expect(usage).toEqual({ tokens: 5 })
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  it('retries retryable API errors with backoff', async () => {
    let attempts = 0
    const value = await withRetry(async () => {
      if (++attempts < 3) {
        throw new APICallError({
          message: 'rate limited',
          provider: 'x',
          url: 'x',
          status: 429,
          responseHeaders: { 'retry-after-ms': '1' },
        })
      }
      return 'ok'
    }, { initialDelay: 1 })
    expect([value, attempts]).toEqual(['ok', 3])
    await expect(withRetry(async () => {
      throw new APICallError({
        message: 'bad',
        provider: 'x',
        url: 'x',
        status: 400,
      })
    })).rejects.toThrow('bad')
  })
})
