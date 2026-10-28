# @hazejs/ai

One API for every major model provider — text, streaming, tool calling, structured output, embeddings and RAG, agents with memory, images, speech and MCP — with **zero vendor SDK dependencies**. Runs on Node.js, Bun, Deno and Cloudflare Workers.

Providers: OpenAI, Anthropic Claude, Google Gemini, Azure OpenAI, AWS Bedrock, Cloudflare Workers AI, DeepSeek, Qwen, Kimi, Zhipu GLM, Doubao, SiliconFlow, OpenRouter, Groq, xAI, Mistral, Ollama and any OpenAI-compatible server.

## Install

```bash
pnpm add @hazejs/ai
```

## Usage

```ts
import { createAnthropic, defineTool, generateText, streamText } from '@hazejs/ai'
import * as v from 'valibot'

const anthropic = createAnthropic() // ANTHROPIC_API_KEY

const weather = defineTool({
  description: 'Get the weather of a city',
  parameters: v.object({
    city: v.string()
  }),
  execute: async ({ city }) => ({ city, sky: 'clear' }),
})

const { text } = await generateText({
  model: anthropic('claude-opus-5-5'),
  prompt: 'Weather in Paris?',
  tools: { weather }
})

// In a hazejs controller (models configured in config/ai.ts):
return AI.streamText({ model: 'fast', messages }).toResponse()
```

Frontend: `useChat` from `@hazejs/ai/vue` or `@hazejs/ai/react`, or the framework-agnostic `createChat` from `@hazejs/ai/client`. Vercel AI SDK UI is supported via `toUIMessageStreamResponse()`.

Part of [hazejs](https://github.com/penna-org/haze) — see the [AI guide](https://penna-org.github.io/haze/guide/ai) for the full documentation.

## License

[MIT](./LICENSE)
