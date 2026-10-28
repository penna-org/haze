import type { EmbeddingModel, Message } from '../src'
import type { CacheLike } from '../src/memory'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { defineTool, generateText, mockModel } from '../src'
import { defineAgent } from '../src/agent'
import { cacheConversationStore, memoryConversationStore, serializeMessages, trimMessages } from '../src/memory'
import { createKnowledgeBase, createMemoryVectorStore, splitText } from '../src/vector'

describe('agents', () => {
  it('runs instructions + tools and remembers conversations', async () => {
    const lookup = defineTool({
      parameters: v.object({
        id: v.string(),
      }),
      execute: ({ id }) => ({ id, status: 'shipped' }),
    })
    const model = mockModel([
      {
        toolCalls: [
          {
            toolName: 'lookup',
            input: { id: 'A1' },
            toolCallId: 't1',
          },
        ],
      },
      'Order A1 has shipped.',
      'You asked about A1.',
    ])
    const memory = memoryConversationStore()
    const agent = defineAgent({
      name: 'support',
      model,
      instructions: ({ context }) => `You help ${context?.user ?? 'someone'}.`,
      tools: { lookup },
      memory,
    })

    const first = await agent.generate({
      prompt: 'Where is order A1?',
      conversationId: 'c1',
      context: { user: 'Ada' },
    })
    expect(first.text).toBe('Order A1 has shipped.')
    expect(model.requests[0].messages[0]).toEqual({ role: 'system', content: 'You help Ada.' })
    // 用户消息、工具调用、工具结果、最终回答都进入记忆
    expect((await memory.load('c1')).map(message => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])

    await agent.generate({ prompt: 'What did I ask?', conversationId: 'c1' })
    const third = model.requests[2].messages
    expect(third.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Where is order A1?', 'What did I ask?'])
  })

  it('streams and saves memory when the stream finishes', async () => {
    const memory = memoryConversationStore()
    const agent = defineAgent({
      model: mockModel('streamed answer'),
      memory,
    })
    const result = await agent.stream({ prompt: 'hi', conversationId: 'c2' })
    expect(await result.text).toBe('streamed answer')
    await result.consume()
    expect(await memory.load('c2')).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'streamed answer' },
        ],
      },
    ])
  })

  it('delegates to sub-agents as tools', async () => {
    const researcher = defineAgent({
      name: 'researcher',
      model: mockModel('Paris is the capital of France.'),
    })
    const lead = mockModel([
      {
        toolCalls: [
          {
            toolName: 'research',
            input: { task: 'capital of France?' },
          },
        ],
      },
      'Done: Paris.',
    ])
    const result = await generateText({
      model: lead,
      prompt: 'x',
      tools: {
        research: researcher.asTool(),
      },
    })
    expect(result.steps[0].toolResults[0].output).toBe('Paris is the capital of France.')
    expect(result.text).toBe('Done: Paris.')
  })
})

describe('conversation memory', () => {
  it('trims at user-message boundaries', () => {
    const history: Message[] = [
      { role: 'user', content: '1' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'a',
            toolName: 't',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'a',
            toolName: 't',
            output: 1,
          },
        ],
      },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '2' },
      { role: 'assistant', content: 'ok' },
    ]
    // 最近 4 条从 tool 消息开始，跳到下一条用户消息
    expect(trimMessages(history, 4).map(message => message.role)).toEqual(['user', 'assistant'])
    expect(trimMessages(history, 10)).toHaveLength(6)
  })

  it('stores JSON-safe history in a cache', async () => {
    const data = new Map<string, unknown>()
    const cache: CacheLike = {
      get: async key => (data.has(key)
        ? JSON.parse(JSON.stringify(data.get(key)))
        : undefined),
      set: async (key, value) => data.set(key, value),
      forget: async key => data.delete(key),
    }
    const memory = cacheConversationStore(cache, { prefix: 'chat:', maxMessages: 10 })
    await memory.append('u1', [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            image: new Uint8Array([137, 80, 78, 71]),
            mediaType: 'image/png',
          },
        ],
      },
    ])
    const [message] = await memory.load('u1')
    expect(message).toEqual({
      role: 'user',
      content: [
        { type: 'image', image: 'data:image/png;base64,iVBORw==', mediaType: 'image/png' },
      ],
    })
    expect([
      ...data.keys(),
    ]).toEqual(['chat:u1'])
    await memory.clear('u1')
    expect(await memory.load('u1')).toEqual([])
    expect(serializeMessages([
      { role: 'user', content: 'plain' },
    ])).toEqual([
      { role: 'user', content: 'plain' },
    ])
  })
})

describe('vector search and knowledge base', () => {
  /** 按关键词出现次数生成向量的确定性 embedding 模型 */
  const keywords = ['refund', 'shipping', 'password']
  const model: EmbeddingModel = {
    kind: 'embedding',
    provider: 'mock',
    modelId: 'keywords',
    async embed({ values }) {
      return {
        embeddings: values.map(value => keywords.map(word => value.toLowerCase().split(word).length - 1 + 0.01)),
      }
    },
  }

  it('splits long text on natural boundaries with overlap', () => {
    const text = `${'First paragraph sentence. '.repeat(30)}\n\n${'Second paragraph sentence. '.repeat(30)}`
    const chunks = splitText(text, { chunkSize: 300, overlap: 30 })
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every(chunk => chunk.length <= 300)).toBe(true)
    expect(splitText('短文本')).toEqual(['短文本'])
    expect(splitText('   ')).toEqual([])
  })

  it('adds, searches, filters and removes documents', async () => {
    const store = createMemoryVectorStore<{ topic: string }>()
    const kb = createKnowledgeBase({ model, store, split: false })
    const ids = await kb.add([
      {
        id: 'r',
        content: 'Refund policy: refund within 30 days. Refund requests…',
        metadata: { topic: 'billing' },
      },
      {
        id: 's',
        content: 'Shipping takes 3 days. Shipping is free.',
        metadata: { topic: 'logistics' },
      },
      {
        id: 'p',
        content: 'Reset your password from the login page.',
        metadata: { topic: 'account' },
      },
    ])
    expect(ids).toEqual(['r', 's', 'p'])
    expect(await store.count()).toBe(3)

    const [best] = await kb.search('how do I get a refund?', { topK: 1 })
    expect(best.record.id).toBe('r')
    expect((await kb.search('shipping', {
      filter: { topic: 'account' },
    })).map(match => match.record.id)).toEqual(['p'])

    const tool = kb.asTool({ topK: 2 })
    const found = await tool.execute!({ query: 'password reset' }, { toolCallId: 'x', messages: [] })
    expect(found[0]).toMatchObject({
      content: expect.stringContaining('password'),
      metadata: { topic: 'account' },
    })

    await kb.remove(['r'])
    expect(await store.count()).toBe(2)
  })

  it('gives split chunks derived ids', async () => {
    const kb = createKnowledgeBase({
      model,
      split: { chunkSize: 50, overlap: 0 },
    })
    const ids = await kb.add([
      {
        id: 'guide',
        content: 'Shipping is fast. '.repeat(10),
      },
    ])
    expect(ids.length).toBeGreaterThan(1)
    expect(ids[0]).toBe('guide#0')
  })
})
