# AI

`@hazejs/ai` 用一套 API 对接主流模型厂商：文本生成、流式输出、工具调用、结构化输出、Embedding 与 RAG、带记忆的 Agent、图像、语音与 MCP。它**不依赖任何厂商 SDK**，每个适配器都直接通过 `fetch` 调用厂商的 HTTP 接口，所以凡是 hazejs 能运行的地方（包括 Cloudflare Workers）都能使用。

::: code-group

```sh [pnpm]
pnpm add @hazejs/ai
```

```sh [npm]
npm install @hazejs/ai
```

:::

用 `pnpm create hazejs` 新建的项目已经内置，并带有流式对话接口和对话页面。

## 厂商

| driver | 厂商 | API Key 环境变量 | 说明 |
| --- | --- | --- | --- |
| `openai` | OpenAI | `OPENAI_API_KEY` | 对话、Embedding、图像、语音合成与识别 |
| `anthropic` | Anthropic Claude | `ANTHROPIC_API_KEY` | 自适应思考、提示缓存、PDF |
| `google` | Google Gemini | `GEMINI_API_KEY` | 思考签名、Embedding、Imagen、TTS |
| `azure` | Azure OpenAI | `AZURE_API_KEY` + `AZURE_RESOURCE_NAME` | v1 API 或部署地址 |
| `bedrock` | AWS Bedrock | AWS 凭证或 `AWS_BEARER_TOKEN_BEDROCK` | Converse API，内置 SigV4 签名 |
| `cloudflare` | Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | REST，或 Worker 内的 `env.AI` 绑定 |
| `deepseek` `qwen` `moonshot` `zhipu` `doubao` `siliconflow` | DeepSeek、通义千问（百炼）、Kimi、智谱 GLM、豆包（方舟）、硅基流动 | `DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`、`MOONSHOT_API_KEY`、`ZHIPU_API_KEY`、`ARK_API_KEY`、`SILICONFLOW_API_KEY` | OpenAI 兼容预设 |
| `openrouter` `groq` `xai` `mistral` | OpenRouter、Groq、xAI、Mistral | `OPENROUTER_API_KEY`、`GROQ_API_KEY`、`XAI_API_KEY`、`MISTRAL_API_KEY` | OpenAI 兼容预设 |
| `ollama` | Ollama（本地） | — | 无需 API Key |
| `openai-compatible` | 任意 OpenAI 兼容服务（vLLM、LM Studio、网关） | `apiKey` 选项 | 需传 `baseURL` |

## 配置

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

模型写作 `厂商:模型`（`providers` 中的键名加厂商的模型 ID），或者使用别名；省略 `model` 时使用 `default`。未设置 `apiKey` 时，从上表中的环境变量读取。

在 hazejs 之外，可以直接传入模型对象，或用 `configureAI()` 注册厂商：

```ts
import { createAnthropic, generateText } from '@hazejs/ai'

const anthropic = createAnthropic()
const { text } = await generateText({ model: anthropic('claude-opus-5-5'), prompt: 'Hello' })
```

## 生成文本

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

- `messages` 传入多轮对话（`system` / `user` / `assistant` / `tool` 消息）；用户消息可以包含图片和文件（`{ type: 'image', image: 字节 | URL }`、`{ type: 'file', data, mediaType: 'application/pdf' }`）。
- `result.response.messages` 是本次新增的 assistant 与 tool 消息，追加到历史即可继续对话。
- `reasoning.effort` 会映射到各厂商的原生设置（Anthropic 的 `output_config.effort`、OpenAI 的 `reasoning_effort`、Gemini 的思考等级）；`reasoning.summary` 在厂商支持时返回可读的推理摘要。
- 厂商专属参数放在 `providerOptions` 中，按厂商名分组：`providerOptions: { anthropic: { cacheControl: true } }`。
- 遇到 429、5xx 或网络错误时自动重试（`maxRetries`，默认 2 次，遵循 `retry-after`）；`timeout` 与 `abortSignal` 可取消请求。

## 流式输出

`streamText` 立即返回，生成在后台进行。可以迭代、等待其中的 Promise，或在控制器中直接返回：

```ts
// app/controller/ChatController.ts
export class ChatController {
  async chat(ctx: HttpContext) {
    const { messages } = await ctx.body<{ messages: Message[] }>()
    return AI.streamText({ system: 'Be helpful.', messages, tools: { currentTime } }).toResponse()
  }
}
```

| 方法 | 输出 |
| --- | --- |
| `toResponse()` | hazejs 的 SSE 协议，配合 `@hazejs/ai/vue` / `@hazejs/ai/react` 使用 |
| `toUIMessageStreamResponse()` | Vercel AI SDK 的 UI Message Stream，配合 `@ai-sdk/vue` / `@ai-sdk/react` 的 `useChat` |
| `toTextStreamResponse()` | 纯文本流 |

```ts
const result = AI.streamText({ prompt: 'Write a haiku' })
for await (const chunk of result.textStream)
  process.stdout.write(chunk)
console.log(await result.totalUsage)
```

`fullStream` 给出全部事件（文本与推理增量、工具调用与结果、步骤边界、完成、错误），可以多次迭代。

## 工具

```ts
import * as v from 'valibot'

const weather = AI.tool({
  description: 'Get the current weather of a city',
  parameters: v.object({ city: v.string() }),
  execute: async ({ city }) => fetchWeather(city),
})

const { text, steps } = await AI.generateText({ prompt: 'Weather in Paris?', tools: { weather } })
```

- 参数可以是任意 Standard Schema（valibot 需安装 `@valibot/to-json-schema`，zod 4、arktype 等）或 `jsonSchema({...})`。执行前先校验参数；参数不合法或 `execute` 抛出异常时，错误作为工具结果回传给模型，让它自行修正。
- 工具带 `execute` 时，模型与工具循环执行，直到模型不再调用工具，最多 `maxSteps` 步（有可执行工具时默认 10，否则 1）。`stopWhen` 与 `onStepFinish` 可以介入每一步。
- **没有** `execute` 的工具会结束循环，把调用交给你处理，适合在客户端执行的工具或需要人工确认的操作。

## 结构化输出

```ts
const Recipe = v.object({ name: v.string(), ingredients: v.array(v.string()) })

const { object } = await AI.generateObject({ schema: Recipe, prompt: 'A simple pancake recipe' })

const stream = AI.streamObject({ schema: Recipe, prompt: '...' })
for await (const partial of stream.partialObjectStream)
  render(partial)
```

结果会按 schema 校验，不符合时抛出 `NoObjectGeneratedError`。各厂商使用自身最可靠的方式：原生 JSON Schema 输出（OpenAI、Anthropic、Gemini、Mistral、xAI、Ollama），JSON 模式加提示（多数兼容厂商），或借一次工具调用（Bedrock）。

## Embedding 与 RAG

```ts
const { embeddings } = await AI.embedMany({ values: ['first', 'second'] })
AI.cosineSimilarity(embeddings[0], embeddings[1])
```

`embedMany` 按模型的单次上限分批，并发请求。做检索时，`createKnowledgeBase` 会切分文档、生成向量并存储：

```ts
import { createKnowledgeBase } from '@hazejs/ai'

const docs = createKnowledgeBase({ model: 'openai:text-embedding-3-small' })
await docs.add([{ id: 'refunds', content: refundPolicy, metadata: { topic: 'billing' } }])

const matches = await docs.search('Can I get my money back?', { topK: 3 })
await AI.generateText({ prompt, tools: { searchDocs: docs.asTool() } })
```

默认存储在内存中。生产环境可以基于 pgvector、Qdrant 等实现只有四个方法的 `VectorStore` 接口，通过 `store` 传入。

## Agent 与对话记忆

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

- 配置了 `memory` 并传入 `conversationId` 时，调用前读取历史，调用后保存本轮对话（包括工具调用）；`stream()` 在流结束后保存。
- `memoryConversationStore()` 把历史保存在进程内；`cacheConversationStore()` 可用于任意 hazejs 缓存存储（Redis、Upstash、KV）。截断历史时以用户消息为界，工具调用不会与结果分开。
- Agent 的 `maxSteps` 默认为 10，与工具是否带 `execute` 无关。
- 与 `AI.streamText()` 不同，`agent.stream()` 返回 Promise，需要先 `await`：`return (await support.stream({ prompt, conversationId })).toResponse()`。
- `agent.asTool()` 把一个 Agent 变成另一个 Agent 的工具（多 Agent 协作）。

## 图像与语音

```ts
const { image } = await AI.generateImage({ model: 'openai:gpt-image-1', prompt: 'A lighthouse at dawn', size: '1024x1024' })
await Storage.disk('public').put('art/lighthouse.png', image.data)

const { audio } = await AI.generateSpeech({ model: 'openai:gpt-4o-mini-tts', text: 'Welcome!', voice: 'coral' })
const { text } = await AI.transcribe({ model: 'openai:whisper-1', audio: await file.arrayBuffer(), language: 'zh' })
```

图像：OpenAI（gpt-image / DALL·E）、Gemini（Imagen 与图像模型）、Azure、Bedrock（Nova Canvas、Titan）、Workers AI、xAI、硅基流动。语音合成：OpenAI、Gemini TTS、Azure、Groq、硅基流动。语音识别：OpenAI、Azure、Groq、硅基流动。

## MCP

连接 MCP 服务并使用其中的工具：

```ts
import { createMCPClient } from '@hazejs/ai'

const github = createMCPClient({ transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { authorization: `Bearer ${token}` } } })
const tools = await github.tools()
await AI.generateText({ prompt: 'List my open issues', tools })
await github.close()
```

传输方式：Streamable HTTP 与 stdio（`{ type: 'stdio', command, args }`）。客户端使用最新的 MCP 协议（2026-07-28），遇到旧服务端时自动回退到带 initialize 握手的协议（2025-11-25 及更早）。

把自己的工具作为 MCP 服务通过路由提供：

```ts
// route/mcp.ts
const server = createMCPServer({ name: 'acme', version: '1.0.0', tools: { lookupOrder } })

export default defineRoutes((r) => {
  r.post('/mcp', ctx => server.handle(ctx.req)).middleware('auth')
})
```

## 前端

`@hazejs/ai/vue` 与 `@hazejs/ai/react` 提供 `useChat`，对接返回 `toResponse()` 的接口：

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

`useChat` 发送的 `{ messages }` 就是服务端的 `Message` 格式，控制器可以直接交给 `streamText`。`headers` 可以是函数（模板中用来发送 CSRF 令牌）。其它前端框架可以使用 `@hazejs/ai/client` 中与框架无关的 `createChat()`。

前端已经在用 Vercel AI SDK？返回 `toUIMessageStreamResponse()`，并用 `convertUIMessages(body.messages)` 转换收到的消息即可。

## 测试

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

`AI.fake(replies)` 会替换所有模型，无论是字符串引用还是模型对象，请求都不会离开进程。回复按顺序使用；一条回复可以是文本，也可以是 `{ toolCalls: [{ toolName, input }] }`，用来测试工具循环。Embedding、图像与语音返回确定性的假数据。断言：`assertPrompted`、`assertNotPrompted`、`assertPromptedTimes`、`assertPromptContains`；`fake.requests` 记录全部请求。

应用之外的单元测试可以使用 `mockModel(replies)`，它是一个独立的模型，回复格式相同。
