import { AI } from '@hazejs/ai'
import { useTestApp } from '@hazejs/testing'
import { afterEach, describe, expect, it } from 'vitest'

const t = useTestApp()

afterEach(() => AI.restore())

describe('chat', () => {
  it('streams the reply as server-sent events', async () => {
    // AI.fake()：不访问真实模型，按顺序返回预设回复并记录请求
    const fake = AI.fake(['Hello! How can I help?'])
    const res = await t.post('/api/chat', {
      messages: [
        { role: 'user', content: 'Hi' },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.body).toContain('event: text')
    expect(res.body).toContain('event: done')
    fake.assertPromptContains('Hi')
  })

  it('runs tools before answering', async () => {
    const fake = AI.fake([
      {
        toolCalls: [
          { toolName: 'currentTime', input: {} },
        ],
      },
      'It is now afternoon.',
    ])
    const res = await t.post('/api/chat', {
      messages: [
        { role: 'user', content: 'What time is it?' },
      ],
    })
    expect(res.body).toContain('event: tool-result')
    fake.assertPromptedTimes(2)
  })

  it('validates the messages', async () => {
    const res = await t.post('/api/chat', { messages: [] })
    expect(res.status).toBe(422)
  })
})
