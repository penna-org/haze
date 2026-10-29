# @hazejs/ai

## 0.2.0

### Minor Changes

- [`2c163ab`](https://github.com/penna-org/haze/commit/2c163abd3d3d1d0162bc38a9e4e5d47cc0417bb1) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - New package `@hazejs/ai`: one API for OpenAI, Anthropic, Gemini, Azure OpenAI, AWS Bedrock, Cloudflare Workers AI and OpenAI-compatible providers (DeepSeek, Qwen, Kimi, GLM, Doubao, SiliconFlow, OpenRouter, Groq, xAI, Mistral, Ollama) — text generation, streaming, tool loops, structured output, embeddings and knowledge bases, agents with conversation memory, images, speech, MCP client and server, `useChat` for Vue and React, AI SDK UI compatibility and `AI.fake()` for tests. New projects include a streaming chat endpoint and chat UI.

- [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Observability: health checks at `/health` (`/health/live`, `/health/ready`, built-in cache / database / Redis / storage / queue checks), optional OpenTelemetry traces and metrics (HTTP, queue jobs with trace propagation, SQL, mail, cache and `gen_ai.*` spans), log channels (stack, JSON, daily files, batched HTTP, custom), and a development dashboard at `/__haze` for requests, queries, jobs, mail, events, cache, logs and AI calls, plus a queue dashboard with retry and forget.

### Patch Changes

- Updated dependencies [[`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450), [`1feefd3`](https://github.com/penna-org/haze/commit/1feefd347c59e86ddbb215b0cddb28172a6bce75), [`704870c`](https://github.com/penna-org/haze/commit/704870c8282875ad5a2d81012a96049e31e77b59), [`d9523dc`](https://github.com/penna-org/haze/commit/d9523dce1bb88b486d6ba78a41d7760c9d57b70a), [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671), [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4), [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac), [`8437ae9`](https://github.com/penna-org/haze/commit/8437ae94e16fef8c96ba64e96fbfad4946c75eec), [`175e253`](https://github.com/penna-org/haze/commit/175e253f1f42dd5466a7c4409c46b04939bbebce), [`b0eaecc`](https://github.com/penna-org/haze/commit/b0eaeccea3472d7b8d095e2f9cc66706c35b8d56), [`743e0c6`](https://github.com/penna-org/haze/commit/743e0c646b305b1532357fe09a51e6665ac8fb33)]:
  - @hazejs/core@0.2.0
