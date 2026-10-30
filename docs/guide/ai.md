# AI

`@hazejs/ai` gives you one API for every major model provider: text generation, streaming, tool calling, structured output, embeddings and RAG, agents with memory, images, speech, and MCP. It has **no vendor SDK dependencies** — every adapter speaks the provider's HTTP protocol directly over `fetch` — so it runs everywhere hazejs runs, including Cloudflare Workers.

::: code-group

```sh [pnpm]
pnpm add @hazejs/ai
```

```sh [npm]
npm install @hazejs/ai
```

:::

New projects created with `pnpm create hazejs` already include it, with a streaming chat endpoint and a chat UI.

## Providers

| Driver | Provider | API key env | Notes |
| --- | --- | --- | --- |
| `openai` | OpenAI | `OPENAI_API_KEY` | Chat, embeddings, images, speech, transcription |
| `anthropic` | Anthropic Claude | `ANTHROPIC_API_KEY` | Adaptive thinking, prompt caching, PDFs |
| `google` | Google Gemini | `GEMINI_API_KEY` | Thought signatures, embeddings, Imagen, TTS |
| `azure` | Azure OpenAI | `AZURE_API_KEY` + `AZURE_RESOURCE_NAME` | v1 API or deployment URLs |
| `bedrock` | AWS Bedrock | AWS credentials or `AWS_BEARER_TOKEN_BEDROCK` | Converse API, SigV4 signing built in |
| `cloudflare` | Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | REST, or the `env.AI` binding inside a Worker |
| `deepseek` `qwen` `moonshot` `zhipu` `doubao` `siliconflow` | DeepSeek, Qwen (DashScope), Kimi, GLM, Doubao (Ark), SiliconFlow | `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `ZHIPU_API_KEY`, `ARK_API_KEY`, `SILICONFLOW_API_KEY` | OpenAI-compatible presets |
| `openrouter` `groq` `xai` `mistral` | OpenRouter, Groq, xAI, Mistral | `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY` | OpenAI-compatible presets |
| `ollama` | Ollama (local) | — | No key needed |
| `openai-compatible` | Any OpenAI-compatible server (vLLM, LM Studio, gateways) | `apiKey` option | Pass `baseURL` |

## Configuration

```ts
// config/ai.ts
import { defineAIConfig } from '@hazejs/ai'
import { env } from '@hazejs/core'

export default defineAIConfig(() => ({
  default: env('AI_MODEL', 'openai:gpt-5-mini'),
  aliases: {
    fast: 'deepseek:deepseek-chat',
    smart: 'anthropic:claude-opus-5-5',
  },
  defaults: { embedding: 'openai:text-embedding-3-small' },
  providers: {
    openai: { driver: 'openai' },
    anthropic: { driver: 'anthropic' },
    deepseek: { driver: 'deepseek' },
    ollama: { driver: 'ollama', baseURL: 'http://localhost:11434/v1' },
  },
}))
```

```ts
// app/provider/AIProvider.ts
import { aiProvider } from '@hazejs/ai'

export default aiProvider()
```

Models are referenced as `provider:model` (the key in `providers`, then the provider's model ID) or by alias. Omit `model` to use `default`. API keys are read from the environment variables in the table above unless you set `apiKey`.

Outside hazejs, pass model objects directly — or register providers with `configureAI()`:

```ts
import { createAnthropic, generateText } from '@hazejs/ai'

const anthropic = createAnthropic()
const { text } = await generateText({ model: anthropic('claude-opus-5-5'), prompt: 'Hello' })
```

## Generating text

```ts
import { AI } from '@hazejs/ai'

const { text, usage, finishReason } = await AI.generateText({
  model: 'smart',
  system: 'You are a concise assistant.',
  prompt: 'Explain HTTP caching in two sentences.',
  maxOutputTokens: 500,
  reasoning: { effort: 'low' },
})
```

- `messages` takes a conversation (`system` / `user` / `assistant` / `tool` messages); user content can include images and files (`{ type: 'image', image: bytes | url }`, `{ type: 'file', data, mediaType: 'application/pdf' }`).
- `result.response.messages` holds the new assistant and tool messages — append them to your history to continue the conversation.
- `reasoning.effort` maps to each provider's native setting (Anthropic `output_config.effort`, OpenAI `reasoning_effort`, Gemini thinking levels); `reasoning.summary` asks for readable reasoning summaries where supported.
- Provider-specific parameters go in `providerOptions`, keyed by provider name: `providerOptions: { anthropic: { cacheControl: true } }`.
- Requests that fail with 429, 5xx or a network error are retried (`maxRetries`, default 2, honoring `retry-after`); `timeout` and `abortSignal` cancel them.

## Streaming

`streamText` returns immediately and runs in the background. Iterate it, await its promises, or return it from a controller:

```ts
// app/controller/ChatController.ts
export class ChatController {
  async chat(ctx: HttpContext) {
    const { messages } = await ctx.body<{ messages: Message[] }>()
    return AI.streamText({ system: 'Be helpful.', messages, tools: { currentTime } }).toResponse()
  }
}
```

| Method | Output |
| --- | --- |
| `toResponse()` | hazejs SSE protocol — use with `@hazejs/ai/vue` / `@hazejs/ai/react` |
| `toUIMessageStreamResponse()` | Vercel AI SDK UI message stream — use with `@ai-sdk/vue` / `@ai-sdk/react` `useChat` |
| `toTextStreamResponse()` | Plain text chunks |

```ts
const result = AI.streamText({ prompt: 'Write a haiku' })
for await (const chunk of result.textStream)
  process.stdout.write(chunk)
console.log(await result.totalUsage)
```

`fullStream` yields every event (text and reasoning deltas, tool calls and results, step boundaries, finish, errors); it can be iterated several times.

## Tools

```ts
import * as v from 'valibot'

const weather = AI.tool({
  description: 'Get the current weather of a city',
  parameters: v.object({ city: v.string() }),
  execute: async ({ city }) => fetchWeather(city),
})

const { text, steps } = await AI.generateText({ prompt: 'Weather in Paris?', tools: { weather } })
```

- Parameters are any Standard Schema (valibot via `@valibot/to-json-schema`, zod 4, arktype) or `jsonSchema({...})`. Inputs are validated before `execute` runs; invalid input and thrown errors are sent back to the model as error results so it can recover.
- When tools have `execute`, the model and tools run in a loop until the model stops calling tools — up to `maxSteps` (default 10 when tools are executable, otherwise 1). `stopWhen` and `onStepFinish` hook into each step.
- A tool **without** `execute` ends the loop and returns the call to you — for client-side tools or human approval.

## Structured output

```ts
const Recipe = v.object({ name: v.string(), ingredients: v.array(v.string()) })

const { object } = await AI.generateObject({ schema: Recipe, prompt: 'A simple pancake recipe' })

const stream = AI.streamObject({ schema: Recipe, prompt: '...' })
for await (const partial of stream.partialObjectStream)
  render(partial)
```

The result is validated against the schema (`NoObjectGeneratedError` otherwise). Each provider uses its strongest mechanism: native JSON Schema output (OpenAI, Anthropic, Gemini, Mistral, xAI, Ollama), JSON mode plus instructions (most compatible providers), or a tool call (Bedrock).

## Embeddings and RAG

```ts
const { embeddings } = await AI.embedMany({ values: ['first', 'second'] })
AI.cosineSimilarity(embeddings[0], embeddings[1])
```

`embedMany` batches by the model's limit and runs batches in parallel. For retrieval, `createKnowledgeBase` splits documents, embeds them and stores the vectors:

```ts
import { createKnowledgeBase } from '@hazejs/ai'

const docs = createKnowledgeBase({ model: 'openai:text-embedding-3-small' })
await docs.add([{ id: 'refunds', content: refundPolicy, metadata: { topic: 'billing' } }])

const matches = await docs.search('Can I get my money back?', { topK: 3 })
await AI.generateText({ prompt, tools: { searchDocs: docs.asTool() } })
```

The default store is in memory. For production, implement the four-method `VectorStore` interface over pgvector, Qdrant or similar and pass it as `store`.

## Agents and memory

```ts
// app/agent/support.ts
import { AI, cacheConversationStore } from '@hazejs/ai'
import { Cache } from '@hazejs/core'

export const support = AI.agent({
  name: 'support',
  model: 'smart',
  instructions: ({ context }) => `You are Acme's support agent. The user is ${context?.name}.`,
  tools: { lookupOrder, refund },
  memory: cacheConversationStore(Cache.store('redis'), { ttl: '7d', maxMessages: 50 }),
})

const { text } = await support.generate({ prompt, conversationId: user.id, context: { name: user.name } })
```

- With `memory` and a `conversationId`, history is loaded before the call and the new turn (including tool calls) is saved after it — for `stream()` too, once the stream finishes.
- `memoryConversationStore()` keeps history in process; `cacheConversationStore()` works with any hazejs cache store (Redis, Upstash, KV). History is trimmed at user-message boundaries so tool calls never lose their results.
- Agents default to `maxSteps: 10`, whether or not their tools have `execute`.
- `agent.stream()` returns a promise, unlike `AI.streamText()`: `return (await support.stream({ prompt, conversationId })).toResponse()`.
- `agent.asTool()` turns an agent into a tool for another agent (multi-agent delegation).

## Images and speech

```ts
const { image } = await AI.generateImage({ model: 'openai:gpt-image-1', prompt: 'A lighthouse at dawn', size: '1024x1024' })
await Storage.disk('public').put('art/lighthouse.png', image.data)

const { audio } = await AI.generateSpeech({ model: 'openai:gpt-4o-mini-tts', text: 'Welcome!', voice: 'coral' })
const { text } = await AI.transcribe({ model: 'openai:whisper-1', audio: await file.arrayBuffer(), language: 'en' })
```

Image models: OpenAI (gpt-image / DALL·E), Gemini (Imagen and image models), Azure, Bedrock (Nova Canvas, Titan), Workers AI, xAI, SiliconFlow. Speech: OpenAI, Gemini TTS, Azure, Groq, SiliconFlow. Transcription: OpenAI, Azure, Groq, SiliconFlow.

## MCP

Connect to MCP servers and use their tools:

```ts
import { createMCPClient } from '@hazejs/ai'

const github = createMCPClient({ transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { authorization: `Bearer ${token}` } } })
const tools = await github.tools()
await AI.generateText({ prompt: 'List my open issues', tools })
await github.close()
```

Transports: Streamable HTTP and stdio (`{ type: 'stdio', command, args }`). The client speaks the current MCP protocol (2026-07-28) and falls back to the initialize-handshake protocol (2025-11-25 and earlier) automatically.

Expose your own tools as an MCP server from a route:

```ts
// route/mcp.ts
const server = createMCPServer({ name: 'acme', version: '1.0.0', tools: { lookupOrder } })

export default defineRoutes((r) => {
  r.post('/mcp', ctx => server.handle(ctx.req)).middleware('auth')
})
```

## Frontend

`@hazejs/ai/vue` and `@hazejs/ai/react` provide `useChat`, which talks to an endpoint returning `toResponse()`:

```vue
<script setup lang="ts">
import { useChat } from '@hazejs/ai/vue'

const { messages, input, status, handleSubmit, stop } = useChat({ api: '/api/chat' })
</script>

<template>
  <div v-for="message in messages" :key="message.id">
    <template v-for="(part, i) in message.parts" :key="i">
      <span v-if="part.type === 'text'">{{ part.text }}</span>
    </template>
  </div>
  <form @submit="handleSubmit">
    <input v-model="input">
    <button v-if="status === 'streaming'" type="button" @click="stop">Stop</button>
  </form>
</template>
```

The hook sends `{ messages }` in the server's `Message` format, so the controller can pass them straight to `streamText`. `headers` can be a function (used by the templates to send the CSRF token). For other frameworks, `@hazejs/ai/client` exports the framework-agnostic `createChat()` store.

Already using the Vercel AI SDK on the frontend? Return `toUIMessageStreamResponse()` and convert incoming messages with `convertUIMessages(body.messages)`.

## Testing

```ts
import { AI } from '@hazejs/ai'

afterEach(() => AI.restore())

it('streams a reply', async () => {
  const fake = AI.fake(['Hello! How can I help?'])
  const res = await t.post('/api/chat', { messages: [{ role: 'user', content: 'Hi' }] })
  expect(res.body).toContain('event: text')
  fake.assertPromptContains('Hi')
})
```

`AI.fake(replies)` replaces every model — string references and model objects alike — so no request leaves the process. Replies are used in order; a reply can be text or `{ toolCalls: [{ toolName, input }] }` to exercise tool loops. Embeddings, images and speech return deterministic fake data. Assertions: `assertPrompted`, `assertNotPrompted`, `assertPromptedTimes`, `assertPromptContains`; `fake.requests` holds every request.

For unit tests outside the app, `mockModel(replies)` is a standalone model with the same reply format.
