import { Buffer } from 'node:buffer'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { APICallError, defineTool, embedMany, generateImage, generateObject, generateSpeech, generateText, streamText } from '../src'
import { createGoogle, pcmToWav } from '../src/providers/google'
import { useMockServer } from './server'

const server = useMockServer()
const google = () => createGoogle({ baseURL: server.url, apiKey: 'g-test' })

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

function reply(parts: unknown[], extra: Record<string, unknown> = {}, finishReason = 'STOP') {
  return {
    json: {
      candidates: [
        {
          content: { role: 'model', parts },
          finishReason,
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 3,
        cachedContentTokenCount: 4,
        totalTokenCount: 22,
      },
      modelVersion: 'gemini-3-flash-001',
      responseId: 'resp-1',
      ...extra,
    },
  }
}

describe('google generateContent', () => {
  it('sends system instruction, merged turns, media, settings and the api key header', async () => {
    server.reply(() => reply([
      { text: 'Let me look', thought: true },
      { text: 'A cat!', thoughtSignature: 'sig-text' },
    ]))
    const result = await generateText({
      model: google()('gemini-3-flash'),
      system: 'Be kind',
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', image: PNG },
            { type: 'file', data: 'https://example.com/doc.pdf', mediaType: 'application/pdf' },
            { type: 'file', data: 'gs://bucket/clip.mp3', mediaType: 'audio/mpeg' },
          ],
        },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Again' },
      ],
      maxOutputTokens: 100,
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      stopSequences: ['END'],
      seed: 7,
      reasoning: { effort: 'low', summary: true },
      providerOptions: {
        google: {
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          ],
          mediaResolution: 'MEDIA_RESOLUTION_LOW',
        },
      },
    })
    expect(server.last.url).toBe('/models/gemini-3-flash:generateContent')
    expect(server.last.headers['x-goog-api-key']).toBe('g-test')
    expect(server.last.json).toEqual({
      systemInstruction: {
        parts: [
          { text: 'Be kind' },
        ],
      },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Hi' },
            { text: 'What is this?' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: Buffer.from(PNG).toString('base64'),
              },
            },
            {
              fileData: { mimeType: 'application/pdf', fileUri: 'https://example.com/doc.pdf' },
            },
            {
              fileData: { mimeType: 'audio/mpeg', fileUri: 'gs://bucket/clip.mp3' },
            },
          ],
        },
        {
          role: 'model',
          parts: [
            { text: 'Earlier answer' },
          ],
        },
        {
          role: 'user',
          parts: [
            { text: 'Again' },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        stopSequences: ['END'],
        seed: 7,
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' },
        mediaResolution: 'MEDIA_RESOLUTION_LOW',
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      ],
    })
    expect(result.text).toBe('A cat!')
    expect(result.reasoningText).toBe('Let me look')
    expect(result.steps[0].content).toEqual([
      { type: 'reasoning', text: 'Let me look' },
      {
        type: 'text',
        text: 'A cat!',
        providerMetadata: {
          google: { thoughtSignature: 'sig-text' },
        },
      },
    ])
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 10,
      totalTokens: 22,
      reasoningTokens: 3,
      cachedInputTokens: 4,
    })
    expect(result.finishReason).toBe('stop')
    expect(result.response).toMatchObject({ id: 'resp-1', modelId: 'gemini-3-flash-001' })
  })

  it('uses thinkingBudget for Gemini 2.5 models', async () => {
    server.reply(() => reply([
      { text: 'ok' },
    ]))
    await generateText({
      model: google()('gemini-2.5-flash'),
      prompt: 'x',
      reasoning: { effort: 'minimal' },
      providerOptions: {
        google: {
          thinkingConfig: { includeThoughts: true },
        },
      },
    })
    expect(server.last.json.generationConfig).toEqual({
      thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
    })
  })

  it('round-trips thought signatures across a two-step tool loop', async () => {
    let call = 0
    server.reply(() => {
      call++
      if (call === 1) {
        return reply([
          { text: 'checking', thought: true },
          {
            functionCall: {
              id: 'fc-1',
              name: 'flight',
              args: { code: 'AA100' },
            },
            thoughtSignature: 'sig-A',
          },
        ])
      }
      if (call === 2) {
        // Gemini 2.5 等不返回 ID 的情况
        return reply([
          {
            functionCall: {
              name: 'taxi',
              args: { time: '10 AM' },
            },
            thoughtSignature: 'sig-B',
          },
        ])
      }
      return reply([
        { text: 'Booked' },
      ])
    })
    const flight = defineTool({
      description: 'Flight status',
      parameters: v.object({
        code: v.string(),
      }),
      execute: () => ({ status: 'delayed' }),
    })
    const taxi = defineTool({
      parameters: v.object({
        time: v.string(),
      }),
      execute: () => 'confirmed',
    })
    const result = await generateText({
      model: google()('gemini-3-flash'),
      prompt: 'Check AA100 and book a taxi',
      tools: { flight, taxi },
      toolChoice: 'auto',
    })
    expect(result.text).toBe('Booked')
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0].finishReason).toBe('tool-calls')
    expect(result.steps[1].toolCalls[0].toolCallId).toMatch(/^google-call-/)

    const first = server.requests[0].json
    expect(first.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'flight',
            description: 'Flight status',
            parametersJsonSchema: {
              type: 'object',
              properties: {
                code: { type: 'string' },
              },
              required: ['code'],
            },
          },
          {
            name: 'taxi',
            parametersJsonSchema: {
              type: 'object',
              properties: {
                time: { type: 'string' },
              },
              required: ['time'],
            },
          },
        ],
      },
    ])
    expect(first.toolConfig).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    })

    expect(server.requests[2].json.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Check AA100 and book a taxi' },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'checking', thought: true },
          {
            functionCall: {
              id: 'fc-1',
              name: 'flight',
              args: { code: 'AA100' },
            },
            thoughtSignature: 'sig-A',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'flight',
              response: { status: 'delayed' },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'taxi',
              args: { time: '10 AM' },
            },
            thoughtSignature: 'sig-B',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'taxi',
              response: { result: 'confirmed' },
            },
          },
        ],
      },
    ])
  })

  it('maps tool choice to functionCallingConfig', async () => {
    server.reply(() => reply([
      { text: 'ok' },
    ]))
    const lookup = defineTool({
      parameters: v.object({
        q: v.string(),
      }),
    })
    await generateText({
      model: google()('gemini-3-flash'),
      prompt: 'x',
      tools: { lookup },
      toolChoice: { toolName: 'lookup' },
    })
    expect(server.last.json.toolConfig).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['lookup'],
      },
    })
    await generateText({
      model: google()('gemini-3-flash'),
      prompt: 'x',
      tools: { lookup },
      toolChoice: 'none',
    })
    expect(server.last.json.toolConfig).toEqual({
      functionCallingConfig: { mode: 'NONE' },
    })
  })

  it('maps finish reasons', async () => {
    const cases: Array<[unknown, string]> = [
      [
        reply([
          { text: 'cut' },
        ], {}, 'MAX_TOKENS'),
        'length',
      ],
      [
        reply([], {}, 'SAFETY'),
        'content-filter',
      ],
      [
        reply([], {}, 'RECITATION'),
        'content-filter',
      ],
      [
        reply([
          { text: 'x' },
        ], {}, 'MALFORMED_FUNCTION_CALL'),
        'other',
      ],
      [
        {
          json: {
            promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
            usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
          },
        },
        'content-filter',
      ],
    ]
    for (const [response, expected] of cases) {
      server.reply(() => response as any)
      const result = await generateText({
        model: google()('gemini-3-flash'),
        prompt: 'x',
      })
      expect(result.finishReason).toBe(expected)
    }
    expect((await generateText({
      model: google()('gemini-3-flash'),
      prompt: 'x',
    })).usage).toEqual({ inputTokens: 3, outputTokens: 0, totalTokens: 3 })
  })

  it('streams thoughts, text and a whole function call', async () => {
    server.reply(() => ({
      sse: [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Hmm ', thought: true },
                ],
              },
            },
          ],
          responseId: 'r-9',
          modelVersion: 'gemini-3-flash-001',
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'ok', thought: true, thoughtSignature: 'sig-T' },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Hel' },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'lo' },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'fc-9',
                      name: 'lookup',
                      args: { q: 'x' },
                    },
                    thoughtSignature: 'sig-F',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 2,
            totalTokenCount: 10,
          },
        },
      ],
    }))
    const lookup = defineTool({
      parameters: v.object({
        q: v.string(),
      }),
    })
    const result = streamText({
      model: google()('gemini-3-flash'),
      prompt: 'x',
      tools: { lookup },
    })
    const events = []
    for await (const event of result.fullStream)
      events.push(event)
    expect(server.last.url).toBe('/models/gemini-3-flash:streamGenerateContent?alt=sse')
    expect(server.last.headers['x-goog-api-key']).toBe('g-test')
    expect(await result.text).toBe('Hello')
    expect(await result.reasoningText).toBe('Hmm ok')
    expect(await result.toolCalls).toEqual([
      {
        toolCallId: 'fc-9',
        toolName: 'lookup',
        input: { q: 'x' },
      },
    ])
    expect(await result.finishReason).toBe('tool-calls')
    expect(await result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
      reasoningTokens: 2,
    })
    expect((await result.response).id).toBe('r-9')
    expect(events.filter(event => event.type === 'tool-call-start')).toEqual([
      { type: 'tool-call-start', toolCallId: 'fc-9', toolName: 'lookup' },
    ])
    const [step] = await result.steps
    expect(step.content).toEqual([
      {
        type: 'reasoning',
        text: 'Hmm ok',
        providerMetadata: {
          google: { thoughtSignature: 'sig-T' },
        },
      },
      { type: 'text', text: 'Hello' },
      {
        type: 'tool-call',
        toolCallId: 'fc-9',
        toolName: 'lookup',
        input: { q: 'x' },
        providerMetadata: {
          google: { thoughtSignature: 'sig-F' },
        },
      },
    ])
  })

  it('keeps a streamed text signature and sends it back', async () => {
    server.reply(() => ({
      sse: [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Hi there' },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: '', thoughtSignature: 'sig-end' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ],
    }))
    const result = streamText({
      model: google()('gemini-3-flash'),
      prompt: 'x',
    })
    expect(await result.text).toBe('Hi there')
    const { messages } = await result.response
    server.reply(() => reply([
      { text: 'again' },
    ]))
    await generateText({
      model: google()('gemini-3-flash'),
      messages: [
        { role: 'user', content: 'x' },
        ...messages,
        { role: 'user', content: 'y' },
      ],
    })
    expect(server.last.json.contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Hi there' },
        { text: '', thoughtSignature: 'sig-end' },
      ],
    })
  })

  it('uses responseJsonSchema for generateObject', async () => {
    server.reply(() => reply([
      { text: '{"title":"Tea"}' },
    ]))
    const { object } = await generateObject({
      model: google()('gemini-3-flash'),
      schema: v.object({
        title: v.string(),
      }),
      prompt: 'x',
    })
    expect(object).toEqual({ title: 'Tea' })
    expect(server.last.json.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
        },
        required: ['title'],
      },
    })
    expect(server.last.json.systemInstruction).toBeUndefined()
  })

  it('throws APICallError with the provider message', async () => {
    server.reply(() => ({
      json: {
        error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
      },
      status: 400,
    }))
    const error = await generateText({
      model: google()('gemini-3-flash'),
      prompt: 'x',
    }).catch(error => error)
    expect(error).toBeInstanceOf(APICallError)
    expect(error).toMatchObject({
      status: 400,
      isRetryable: false,
      provider: 'google',
      message: 'google API error 400: API key not valid. Please pass a valid API key.',
    })
  })

  it('reads GEMINI_API_KEY, then GOOGLE_GENERATIVE_AI_API_KEY', async () => {
    const previous = [process.env.GEMINI_API_KEY, process.env.GOOGLE_GENERATIVE_AI_API_KEY]
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    server.reply(() => reply([
      { text: 'ok' },
    ]))
    const provider = createGoogle({ baseURL: server.url })
    try {
      await expect(generateText({
        model: provider('gemini-3-flash'),
        prompt: 'x',
      })).rejects.toThrow('Google API key is missing')
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'fallback-key'
      await generateText({
        model: provider('gemini-3-flash'),
        prompt: 'x',
      })
      expect(server.last.headers['x-goog-api-key']).toBe('fallback-key')
      process.env.GEMINI_API_KEY = 'gemini-key'
      await generateText({
        model: provider('gemini-3-flash'),
        prompt: 'x',
      })
      expect(server.last.headers['x-goog-api-key']).toBe('gemini-key')
    }
    finally {
      for (const [index, name] of ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'].entries()) {
        if (previous[index] === undefined)
          delete process.env[name]
        else
          process.env[name] = previous[index]
      }
    }
  })
})

describe('google media endpoints', () => {
  it('embeds with batchEmbedContents', async () => {
    server.reply(() => ({
      json: {
        embeddings: [
          {
            values: [1, 0],
          },
          {
            values: [0, 1],
          },
        ],
        usageMetadata: { promptTokenCount: 4 },
      },
    }))
    const { embeddings, usage } = await embedMany({
      model: google().embeddingModel!('gemini-embedding-001'),
      values: ['a', 'b'],
      dimensions: 2,
      providerOptions: {
        google: { taskType: 'RETRIEVAL_DOCUMENT' },
      },
    })
    expect(embeddings).toEqual([
      [1, 0],
      [0, 1],
    ])
    expect(usage).toEqual({ tokens: 4 })
    expect(server.last.url).toBe('/models/gemini-embedding-001:batchEmbedContents')
    expect(server.last.json).toEqual({
      requests: [
        {
          model: 'models/gemini-embedding-001',
          content: {
            parts: [
              { text: 'a' },
            ],
          },
          outputDimensionality: 2,
          taskType: 'RETRIEVAL_DOCUMENT',
        },
        {
          model: 'models/gemini-embedding-001',
          content: {
            parts: [
              { text: 'b' },
            ],
          },
          outputDimensionality: 2,
          taskType: 'RETRIEVAL_DOCUMENT',
        },
      ],
    })
    expect(google().embeddingModel!('gemini-embedding-001').maxBatchSize).toBe(100)
  })

  it('generates images with Imagen :predict', async () => {
    server.reply(() => ({
      json: {
        predictions: [
          {
            bytesBase64Encoded: Buffer.from('img-1').toString('base64'),
            mimeType: 'image/png',
          },
          {
            bytesBase64Encoded: Buffer.from('img-2').toString('base64'),
            mimeType: 'image/png',
          },
        ],
      },
    }))
    const { images } = await generateImage({
      model: google().imageModel!('imagen-4.0-generate-001'),
      prompt: 'a cat',
      n: 2,
      aspectRatio: '16:9',
    })
    expect(images.map(image => Buffer.from(image.data).toString())).toEqual(['img-1', 'img-2'])
    expect(images[0].mediaType).toBe('image/png')
    expect(server.last.url).toBe('/models/imagen-4.0-generate-001:predict')
    expect(server.last.json).toEqual({
      instances: [
        { prompt: 'a cat' },
      ],
      parameters: { sampleCount: 2, aspectRatio: '16:9' },
    })
  })

  it('generates images with Gemini image models via generateContent', async () => {
    server.reply(() => reply([
      { text: 'Here you go' },
      {
        inlineData: {
          mimeType: 'image/png',
          data: Buffer.from('draft').toString('base64'),
        },
        thought: true,
      },
      {
        inlineData: {
          mimeType: 'image/png',
          data: Buffer.from('final').toString('base64'),
        },
        thoughtSignature: 'sig-img',
      },
    ]))
    const { image, images, warnings } = await generateImage({
      model: google().imageModel!('gemini-3-pro-image'),
      prompt: 'a cat',
      aspectRatio: '1:1',
      size: '2k',
    })
    expect(images).toHaveLength(1)
    expect(Buffer.from(image.data).toString()).toBe('final')
    expect(warnings).toEqual([])
    expect(server.last.url).toBe('/models/gemini-3-pro-image:generateContent')
    expect(server.last.json).toEqual({
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'a cat' },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
      },
    })
  })

  it('wraps raw PCM speech into a WAV file', async () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0])
    server.reply(() => reply([
      {
        inlineData: {
          mimeType: 'audio/L16;codec=pcm;rate=24000',
          data: Buffer.from(pcm).toString('base64'),
        },
      },
    ]))
    const { audio } = await generateSpeech({
      model: google().speechModel!('gemini-2.5-flash-preview-tts'),
      text: 'Hello',
      instructions: 'cheerful',
    })
    expect(server.last.url).toBe('/models/gemini-2.5-flash-preview-tts:generateContent')
    expect(server.last.json).toEqual({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Hello',
              speechMetadata: { style: 'cheerful' },
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    })
    expect(audio.mediaType).toBe('audio/wav')
    const wav = Buffer.from(audio.data)
    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length)
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(24000)
    expect(wav.readUInt32LE(28)).toBe(48000)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(pcm.length)
    expect([
      ...wav.subarray(44),
    ]).toEqual([...pcm])
  })

  it('passes WAV speech through and returns raw PCM on request', async () => {
    const pcm = new Uint8Array([9, 0, 8, 0])
    const wav = pcmToWav(pcm, 16000)
    server.reply(() => reply([
      {
        inlineData: {
          mimeType: 'audio/wav',
          data: Buffer.from(wav).toString('base64'),
        },
      },
    ]))
    const model = google().speechModel!('gemini-3.8-flash-tts')
    const { audio } = await generateSpeech({ model, text: 'Hi', voice: 'Puck' })
    expect(audio.mediaType).toBe('audio/wav')
    expect([...audio.data]).toEqual([...wav])
    expect(server.last.json.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck')
    const { audio: raw } = await generateSpeech({ model, text: 'Hi', format: 'pcm' })
    expect(raw.mediaType).toBe('audio/pcm')
    expect([...raw.data]).toEqual([...pcm])
  })
})
