import type { ChatStatus } from '../src/client'
import type { UIMessage, UIMessageChunk } from '../src/protocol/ui-message-stream'
import type { LanguageModel, Message, ModelStreamPart } from '../src/types'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { defineTool, mockModel, streamText } from '../src'
import { createChat, parseChatStream, toModelMessages } from '../src/client'
import { useChat } from '../src/client/vue'
import { convertUIMessages, UI_MESSAGE_STREAM_HEADER } from '../src/protocol/ui-message-stream'

const weather = defineTool({
  description: 'Get the weather of a city',
  parameters: v.object({
    city: v.string(),
  }),
  execute: async ({ city }) => ({ city, temperature: 21 }),
})

/** 进程内的“服务端”：请求体中的 messages 直接交给 streamText */
function serverFetch(model: LanguageModel, bodies: unknown[] = []) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Message[] }
    bodies.push(body)
    return streamText({
      model,
      messages: body.messages,
      tools: { weather },
      abortSignal: init?.signal ?? undefined,
      onError: () => {},
    }).toResponse()
  }
}

let ids = 0
const generateId = () => `id-${++ids}`

async function readUIChunks(response: Response) {
  const text = await response.text()
  return text.split('\n\n').filter(Boolean).map((line) => {
    expect(line.startsWith('data: ')).toBe(true)
    const data = line.slice('data: '.length)
    return data === '[DONE]'
      ? '[DONE]'
      : JSON.parse(data) as UIMessageChunk
  })
}

describe('parseChatStream', () => {
  it('parses the hazejs SSE protocol', async () => {
    const response = streamText({
      model: mockModel('Hi there'),
      prompt: 'Hi',
    }).toResponse()
    expect(response.headers.get('x-hazejs-ai-stream')).toBe('v1')
    const events = []
    for await (const event of parseChatStream(response))
      events.push(event)
    expect(events.map(event => event.type)).toEqual([
      'start',
      'text',
      'text',
      'step',
      'finish',
      'done',
    ])
    expect(events[1]).toEqual({ type: 'text', delta: 'Hi ' })
  })
})

describe('createChat', () => {
  it('streams a reply, runs a tool step and tracks status', async () => {
    ids = 0
    const model = mockModel([
      {
        text: 'Let me check.',
        toolCalls: [
          {
            toolName: 'weather',
            input: { city: 'Paris' },
            toolCallId: 'c1',
          },
        ],
      },
      'It is 21°C.',
    ])
    const bodies: unknown[] = []
    const statuses: ChatStatus[] = []
    let finished: unknown
    const chat = createChat({
      fetch: serverFetch(model, bodies),
      generateId,
      body: { sessionId: 's1' },
      onFinish: (message, info) => {
        finished = {
          message,
          finishReason: info.finishReason,
          usage: info.usage,
          aborted: info.aborted,
        }
      },
    })
    chat.subscribe(() => {
      if (statuses.at(-1) !== chat.status)
        statuses.push(chat.status)
    })

    const promise = chat.sendMessage('Weather in Paris?')
    expect(chat.status).toBe('submitted')
    await promise

    // 第一次通知来自追加的用户消息
    expect(statuses).toEqual([
      'ready',
      'submitted',
      'streaming',
      'ready',
    ])
    expect(chat.error).toBeUndefined()
    expect(chat.messages).toEqual([
      {
        id: 'id-1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Weather in Paris?' },
        ],
      },
      {
        id: 'id-2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool',
            toolCallId: 'c1',
            toolName: 'weather',
            state: 'output-available',
            input: { city: 'Paris' },
            output: { city: 'Paris', temperature: 21 },
          },
          { type: 'text', text: 'It is 21°C.' },
        ],
      },
    ])
    expect(bodies[0]).toEqual({
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
      ],
    })
    expect(finished).toEqual({
      message: chat.messages[1],
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      aborted: false,
    })

    // 第二轮：客户端回传的历史（含工具调用与结果）与服务端第一轮的 responseMessages 一致
    await chat.sendMessage('Thanks')
    const expected: Message[] = [
      { role: 'user', content: 'Weather in Paris?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
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
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'It is 21°C.' },
        ],
      },
      { role: 'user', content: 'Thanks' },
    ]
    expect((bodies[1] as { messages: Message[] }).messages).toEqual(expected)
    // 原样进入模型的第三次请求
    expect(model.requests[2].messages).toEqual(expected)
    expect(chat.messages).toHaveLength(4)
  })

  it('keeps the state snapshot stable between changes (useSyncExternalStore)', async () => {
    const chat = createChat({
      fetch: serverFetch(mockModel('Hi')),
    })
    const before = chat.state
    expect(chat.state).toBe(before)
    let notified = 0
    const unsubscribe = chat.subscribe(() => notified++)
    await chat.sendMessage('Hello')
    expect(chat.state).not.toBe(before)
    expect(chat.state).toBe(chat.state)
    expect(notified).toBeGreaterThan(0)
    unsubscribe()
    const count = notified
    chat.setMessages([])
    expect(notified).toBe(count)
    expect(chat.messages).toEqual([])
  })

  it('regenerates the last reply', async () => {
    const model = mockModel(['First', 'Second'])
    const chat = createChat({
      fetch: serverFetch(model),
    })
    await chat.sendMessage('Hi')
    await chat.regenerate()
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[1].parts).toEqual([
      { type: 'text', text: 'Second' },
    ])
    expect(model.requests[1].messages).toEqual([
      { role: 'user', content: 'Hi' },
    ])
  })

  it('stops a running request and keeps the partial reply', async () => {
    let aborted = false
    // 输出一段文本后挂起，直到请求被中止
    const model: LanguageModel = {
      kind: 'language',
      provider: 'test',
      modelId: 'slow',
      generate: async () => { throw new Error('not used') },
      stream: async request => new ReadableStream<ModelStreamPart>({
        start(controller) {
          controller.enqueue({ type: 'text-delta', text: 'Hello ' })
          request.signal?.addEventListener('abort', () => {
            aborted = true
            controller.error(request.signal!.reason)
          })
        },
      }),
    }
    let finishedAborted: boolean | undefined
    const chat = createChat({
      fetch: serverFetch(model),
      onEvent: (event) => {
        if (event.type === 'text')
          chat.stop()
      },
      onFinish: (_message, info) => {
        finishedAborted = info.aborted
      },
    })
    await chat.sendMessage('Hi')
    expect(chat.status).toBe('ready')
    expect(chat.error).toBeUndefined()
    expect(chat.messages[1].parts).toEqual([
      { type: 'text', text: 'Hello ' },
    ])
    expect(finishedAborted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(aborted).toBe(true)
  })

  it('reports stream errors', async () => {
    const model = mockModel(() => {
      throw new Error('model exploded')
    })
    const errors: Error[] = []
    const chat = createChat({
      fetch: serverFetch(model),
      onError: error => void errors.push(error),
    })
    await chat.sendMessage('Hi')
    expect(chat.status).toBe('error')
    expect(chat.error?.message).toBe('model exploded')
    expect(errors).toHaveLength(1)
    chat.clearError()
    expect(chat.status).toBe('ready')
  })

  it('reports HTTP errors', async () => {
    const chat = createChat({
      fetch: async () => new Response('Unauthorized', { status: 401 }),
    })
    await chat.sendMessage('Hi')
    expect(chat.status).toBe('error')
    expect(chat.error?.message).toBe('Unauthorized')
    expect(chat.messages).toHaveLength(1)
  })

  it('sends files and resolves dynamic headers', async () => {
    let request: { headers: Record<string, string>, body: { messages: Message[] } } | undefined
    const chat = createChat({
      api: '/chat',
      headers: async () => ({ authorization: 'Bearer t' }),
      fetch: async (_url, init) => {
        request = {
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)),
        }
        return streamText({
          model: mockModel('ok'),
        }).toResponse()
      },
    })
    await chat.sendMessage({
      text: 'What is this?',
      files: [
        { url: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
      ],
    })
    expect(request?.headers.authorization).toBe('Bearer t')
    expect(request?.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', image: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
          { type: 'text', text: 'What is this?' },
        ],
      },
    ])
  })
})

describe('toModelMessages', () => {
  it('drops tool calls without results and splits steps', () => {
    expect(toModelMessages([
      {
        id: '1',
        role: 'system',
        parts: [
          { type: 'text', text: 'Be brief' },
        ],
      },
      {
        id: '2',
        role: 'user',
        parts: [
          { type: 'text', text: 'Hi' },
        ],
      },
      {
        id: '3',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Thinking' },
          {
            type: 'tool',
            toolCallId: 'a',
            toolName: 'weather',
            state: 'output-error',
            input: { city: 'X' },
            errorText: 'Unknown city',
          },
          {
            type: 'tool',
            toolCallId: 'b',
            toolName: 'weather',
            state: 'input-available',
            input: { city: 'Y' },
          },
          { type: 'text', text: 'Sorry' },
        ],
      },
    ])).toEqual([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Thinking' },
          {
            type: 'tool-call',
            toolCallId: 'a',
            toolName: 'weather',
            input: { city: 'X' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'a',
            toolName: 'weather',
            output: 'Unknown city',
            isError: true,
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sorry' },
        ],
      },
    ])
  })
})

describe('aI SDK UI message stream', () => {
  it('encodes events as UI message chunks', async () => {
    const model = mockModel([
      {
        reasoning: 'Thinking',
        text: 'Let me check.',
        toolCalls: [
          {
            toolName: 'weather',
            input: { city: 'Paris' },
            toolCallId: 'c1',
          },
        ],
      },
      'Sunny.',
    ])
    const response = streamText({
      model,
      prompt: 'Weather?',
      tools: { weather },
    }).toUIMessageStreamResponse({
      messageId: 'm1',
      headers: { 'x-custom': '1' },
    })
    expect(response.headers.get(UI_MESSAGE_STREAM_HEADER)).toBe('v1')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('x-custom')).toBe('1')
    expect(await readUIChunks(response)).toEqual([
      { type: 'start', messageId: 'm1' },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'reasoning-0' },
      { type: 'reasoning-delta', id: 'reasoning-0', delta: 'Thinking' },
      { type: 'reasoning-end', id: 'reasoning-0' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Let ' },
      { type: 'text-delta', id: 'text-1', delta: 'me ' },
      { type: 'text-delta', id: 'text-1', delta: 'check.' },
      { type: 'text-end', id: 'text-1' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'weather' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"city":"Paris"}' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'weather',
        input: { city: 'Paris' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'c1',
        output: { city: 'Paris', temperature: 21 },
      },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-2' },
      { type: 'text-delta', id: 'text-2', delta: 'Sunny.' },
      { type: 'text-end', id: 'text-2' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
      '[DONE]',
    ])
  })

  it('encodes tool errors and stream errors', async () => {
    const failing = defineTool({
      parameters: v.object({}),
      execute: async () => {
        throw new Error('boom')
      },
    })
    const response = streamText({
      model: mockModel({
        toolCalls: [
          { toolName: 'failing', input: {}, toolCallId: 'c1' },
        ],
      }),
      prompt: 'Go',
      tools: { failing },
      maxSteps: 1,
    }).toUIMessageStreamResponse()
    const chunks = await readUIChunks(response)
    expect(chunks).toContainEqual({ type: 'tool-output-error', toolCallId: 'c1', errorText: 'boom' })
    expect(chunks.at(-2)).toEqual({ type: 'finish', finishReason: 'tool-calls' })

    const broken = streamText({
      model: mockModel(() => {
        throw new Error('model exploded')
      }),
      prompt: 'Hi',
      onError: () => {},
    }).toUIMessageStreamResponse({
      onError: () => 'Something went wrong',
    })
    expect(await readUIChunks(broken)).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'error', errorText: 'Something went wrong' },
      '[DONE]',
    ])
  })

  it('omits reasoning when sendReasoning is false', async () => {
    const response = streamText({
      model: mockModel({ reasoning: 'secret', text: 'Hi' }),
      prompt: 'Hi',
    })
      .toUIMessageStreamResponse({ sendReasoning: false })
    const chunks = await readUIChunks(response)
    expect(chunks.some(chunk => typeof chunk === 'object' && chunk.type.startsWith('reasoning'))).toBe(false)
  })

  it('converts UIMessages from useChat into messages', () => {
    const uiMessages: UIMessage[] = [
      {
        id: 's',
        role: 'system',
        parts: [
          { type: 'text', text: 'Be brief' },
        ],
      },
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', text: 'What is in these?' },
          { type: 'file', url: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
          {
            type: 'file',
            url: 'https://example.com/a.pdf',
            mediaType: 'application/pdf',
            filename: 'a.pdf',
          },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'reasoning',
            text: 'Hmm',
            state: 'done',
            providerMetadata: {
              anthropic: { signature: 'sig' },
            },
          },
          { type: 'text', text: 'Checking.', state: 'done' },
          {
            type: 'tool-weather',
            toolCallId: 'c1',
            state: 'output-available',
            input: { city: 'Paris' },
            output: { temperature: 21 },
            callProviderMetadata: {
              google: { thoughtSignature: 't' },
            },
          },
          {
            type: 'dynamic-tool',
            toolName: 'lookup',
            toolCallId: 'c2',
            state: 'output-error',
            input: { q: 'x' },
            errorText: 'Not found',
          },
          {
            type: 'tool-weather',
            toolCallId: 'c3',
            state: 'input-streaming',
            input: { ci: 1 },
          },
          { type: 'step-start' },
          { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
          { type: 'text', text: 'It is 21°C.', state: 'done' },
          {
            type: 'data-weather',
            data: { ok: true },
          },
        ],
      },
      {
        id: 'u2',
        role: 'user',
        parts: [
          { type: 'text', text: 'Thanks' },
        ],
      },
    ]
    expect(convertUIMessages(uiMessages)).toEqual([
      { role: 'system', content: 'Be brief' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in these?' },
          { type: 'image', image: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
          {
            type: 'file',
            data: 'https://example.com/a.pdf',
            mediaType: 'application/pdf',
            filename: 'a.pdf',
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'Hmm',
            providerMetadata: {
              anthropic: { signature: 'sig' },
            },
          },
          { type: 'text', text: 'Checking.' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'weather',
            input: { city: 'Paris' },
            providerMetadata: {
              google: { thoughtSignature: 't' },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'lookup',
            input: { q: 'x' },
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
            output: { temperature: 21 },
          },
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'lookup',
            output: 'Not found',
            isError: true,
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'It is 21°C.' },
        ],
      },
      { role: 'user', content: 'Thanks' },
    ])
  })

  it('serves a useChat request end to end', async () => {
    const body = {
      id: 'chat-1',
      trigger: 'submit-message',
      messages: [
        {
          id: 'u1',
          role: 'user',
          parts: [
            { type: 'text', text: 'Hi' },
          ],
        },
      ] satisfies UIMessage[],
    }
    const model = mockModel('Hello!')
    const response = streamText({
      model,
      messages: convertUIMessages(body.messages),
    }).toUIMessageStreamResponse()
    const chunks = await readUIChunks(response)
    expect(model.requests[0].messages).toEqual([
      { role: 'user', content: 'Hi' },
    ])
    expect(chunks.filter(chunk => typeof chunk === 'object' && chunk.type === 'text-delta').map(chunk => (chunk as { delta: string }).delta).join('')).toBe('Hello!')
  })
})

describe('vue useChat', () => {
  it('exposes reactive state and unsubscribes on dispose', async () => {
    const scope = effectScope()
    const chat = scope.run(() => useChat({
      fetch: serverFetch(mockModel('Hi from Vue')),
    }))!
    expect(chat.status.value).toBe('ready')
    chat.input.value = '  Hello  '
    let prevented = false
    const promise = chat.handleSubmit({
      preventDefault: () => void (prevented = true),
    })
    expect(prevented).toBe(true)
    expect(chat.input.value).toBe('')
    expect(chat.status.value).toBe('submitted')
    await promise
    await nextTick()
    expect(chat.status.value).toBe('ready')
    expect(chat.messages.value.map(message => message.parts)).toEqual([
      [
        { type: 'text', text: 'Hello' },
      ],
      [
        { type: 'text', text: 'Hi from Vue' },
      ],
    ])

    // 空输入不发送
    await chat.handleSubmit()
    expect(chat.messages.value).toHaveLength(2)

    scope.stop()
    chat.setMessages([])
    expect(chat.chat.messages).toEqual([])
    // 已取消订阅，ref 不再更新
    expect(chat.messages.value).toHaveLength(2)
  })
})
