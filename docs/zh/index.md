---
layout: home

hero:
  name: hazejs
  text: 功能完整的 TypeScript 后端框架
  tagline: 路由、ORM、认证、队列、实时通信、文件存储与邮件，统一在一套框架中，运行于 Node.js、Bun、Deno 与 Edge。
  image:
    src: /logo.svg
    alt: hazejs
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 什么是 hazejs
      link: /zh/guide/
    - theme: alt
      text: GitHub
      link: https://github.com/penna-org/haze

features:
  - icon: 🧰
    title: 功能齐全
    details: 路由、IoC 容器、校验、ORM 与迁移、认证、授权、CSRF、限流、缓存、队列、定时任务、事件、WebSocket、Socket.IO、文件存储与邮件，全部由官方提供，风格统一。
  - icon: ⚡
    title: 热更新不重启
    details: haze dev 原地替换控制器、服务、路由和配置，数据库连接池、Redis 连接和 Socket 在每次修改后保持不断。
  - icon: 🧩
    title: Vite 全栈
    details: 在任意 Vite 项目（Vue、React、Svelte 或无框架）中加入 haze()：同一个仓库，开发时同一个端口，生产环境一次构建。
  - icon: 🔭
    title: 开发者工具
    details: 看清模块、事件、任务与定时任务之间的联动，用瀑布图追踪每个请求，回看并试运行 AI 调用、随时执行任务；编码代理也能通过 MCP 查询同样的信息。
    link: /zh/guide/devtools
    linkText: 查看开发者工具
  - icon: 🤖
    title: 内置 AI
    details: 无需 SDK 依赖即可接入 OpenAI、Anthropic、Gemini 等厂商：流式输出、工具调用、结构化输出、向量嵌入、Agent 与 MCP，另有面向 Vue 与 React 的 useChat。
    link: /zh/guide/ai
    linkText: 查看 AI 指南
  - icon: 🌍
    title: 随处部署
    details: 提供 node、bun、deno、docker、cloudflare、vercel、netlify、aws-lambda 预设，原生依赖自动追踪进产物，可独立运行。
  - icon: ☁️
    title: Edge 原生驱动
    details: Cloudflare D1、KV、R2、Queues、Cron Triggers 与 Durable Objects；Turso HTTP；Serverless 场景的 Upstash Redis。
  - icon: ✅
    title: 类型完整、易于测试
    details: 配置、路由、授权能力自动生成类型，请求校验遵循 Standard Schema，队列、事件、邮件、存储都有测试替身。
---
