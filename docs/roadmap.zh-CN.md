# 路线图与框架对比

[English](./roadmap.md) · 简体中文

hazejs 的目标是成为 Node.js 生态中最完整的后端框架：生产应用需要的能力都由官方提供，风格统一、类型完整、可以部署到任何平台，同时保持快速、现代的工具链。

本页对比 hazejs 当前的能力与其它常见选择，并列出补齐剩余差距的计划。

## 对比

图例：✅ 官方内置 · ◐ 官方扩展包或部分支持 · 🧩 社区包 / 自行集成 · — 不提供

以下内容按 2026 年 10 月各框架的官方包整理，如有出入欢迎提 Issue 指正。

| 能力 | hazejs | NestJS | AdonisJS | Laravel（PHP，参照） | Express / Fastify / Hono |
| --- | --- | --- | --- | --- | --- |
| 路由、中间件、异常处理 | ✅ | ✅ | ✅ | ✅ | ✅（路由与中间件） |
| 依赖注入 | ✅ `inject()` | ✅ 装饰器 | ✅ | ✅ | — |
| 请求校验 | ✅ Standard Schema | ◐ class-validator | ✅ VineJS | ✅ | 🧩 |
| ORM、迁移、数据填充 | ✅ 基于 drizzle | 🧩 TypeORM / Prisma | ✅ Lucid | ✅ Eloquent | 🧩 |
| 认证（JWT、Session） | ✅ | ◐ Passport | ✅ | ✅ | 🧩 |
| 授权（Gate、Policy） | ✅ | 🧩 CASL | ✅ Bouncer | ✅ | 🧩 |
| CSRF、CORS、安全头、限流 | ✅ | ◐ | ✅ | ✅ | 🧩 |
| 缓存与原子锁 | ✅ | ◐ | ✅ | ✅ | 🧩 |
| 队列（重试、延迟） | ✅ | ◐ BullMQ 模块 | 🧩 | ✅ | 🧩 |
| 定时任务 | ✅ | ◐ | 🧩 | ✅ | 🧩 |
| 事件与排队监听器 | ✅ | ◐ | ✅ | ✅ | — |
| WebSocket / Socket.IO | ✅ 两者都支持 | ✅ Gateway | ◐ SSE（Transmit） | ✅ Reverb | 🧩 |
| 文件存储（local / S3 / R2） | ✅ | 🧩 | ✅ Drive | ✅ | 🧩 |
| 邮件与排队发送 | ✅ | 🧩 | ✅ | ✅ | 🧩 |
| 测试替身（队列、事件、邮件、存储） | ✅ | ◐ | ✅ | ✅ | — |
| 代码生成与命令行 | ✅ `haze make:*` | ✅ | ✅ | ✅ | — |
| 类型生成（配置、路由、授权能力） | ✅ | — | ◐ | — | ◐（Hono RPC） |
| 不重启进程的热更新 | ✅ | ◐ | ✅ hot-hook | 不适用 | 🧩 |
| Vite 全栈（同端口、一次构建） | ✅ 任意 Vite 框架 | — | ◐ Inertia / Vite | ◐ Vite / Inertia | — |
| Edge 与 Serverless 部署预设 | ✅ 8 个预设 | — | — | ◐ Vapor | ◐ Hono |
| Cloudflare D1 / KV / R2 / Queues / DO 驱动 | ✅ | — | — | — | ◐ Hono（绑定） |
| OpenAPI 生成 | 计划中 | ✅ | 🧩 | 🧩 | ◐ |
| 国际化 | 计划中 | 🧩 | ✅ | ✅ | 🧩 |
| 多渠道通知 | 计划中 | — | 🧩 | ✅ | — |
| 私有 / Presence 频道广播 | 计划中 | — | ◐ | ✅ | — |
| 自定义命令、REPL | 计划中 | 🧩 | ✅ | ✅ | — |
| 可观测性（健康检查、链路追踪、面板） | 计划中 | ◐ | ◐ | ✅ Telescope / Pulse / Horizon | 🧩 |
| OAuth 社交登录、API Token、双因素认证 | 计划中 | 🧩 | ◐ Ally / Token | ✅ | 🧩 |
| 全文搜索 | 计划中 | 🧩 | 🧩 | ✅ Scout | 🧩 |
| GraphQL、微服务传输 | 计划中 | ✅ | 🧩 | 🧩 | 🧩 |
| 文档站 | 计划中 | ✅ | ✅ | ✅ | ✅ |

## 已完成

| 里程碑 | 内容 |
| --- | --- |
| M0–M4 | monorepo、运行时内核（容器、路由、中间件、异常）、带热更新的 Vite 插件、命令行、Vue 全栈、脚手架、测试工具、代码生成、类型生成、日志、开发错误页 |
| M5–M6 | 响应格式化、出站拦截器、多应用（前缀 / 域名） |
| M7–M8 | `@hazejs/orm`（MySQL、PostgreSQL、SQLite）与 MongoDB 适配器 |
| M9–M11 | 部署预设、生产迁移、D1 / Turso 驱动、依赖追踪、`vite preview`、React 模板 |
| M12–M13 | 内置中间件、上传、Session、认证（JWT / Session）、授权（Gate / Policy）、CSRF |
| M14–M16 | 缓存、队列、定时任务、事件、WebSocket（Redis 广播、Durable Objects） |
| M17–M18 | Socket.IO、文件存储（local / S3 / R2）、邮件（SMTP / Resend / Postmark / Mailgun / SES） |

## 后续计划

优先级会根据社区反馈调整。每个里程碑都带测试、模板示例和文档，并在开发服务器、测试以及声明支持的每个部署预设中可用。

| 里程碑 | 内容 |
| --- | --- |
| M19 | **文档站**（VitePress，英文 + 中文）：每个模块的指南、API 参考、部署方案；模板 README 提供英文版 |
| M20 | **OpenAPI**：由路由与 Standard Schema 校验生成，提供 Swagger / Scalar 界面，以及给前端用的类型化 HTTP 客户端 |
| M21 | **命令行扩展**：自定义命令（`app/command`、`haze make:command`）、`haze repl`、`make:mail` |
| M22 | **通知**（邮件、数据库、广播、Slack / Webhook）与**广播频道**（私有 / Presence 频道鉴权，基于 WebSocket、Socket.IO 与 SSE） |
| M23 | **国际化**（消息、校验错误、邮件）、API Resource / 转换器、签名路由链接、加密服务 |
| M24 | **可观测性**：健康检查、OpenTelemetry 链路与指标、日志传输、开发面板（请求、查询、任务、邮件）、队列面板 |
| M25 | **认证扩展**：OAuth 社交登录、个人访问令牌、邮箱验证与重置密码流程、TOTP 双因素认证、Passkey |
| M26 | **搜索**（数据库、Meilisearch、Typesense）与多租户辅助 |
| M27 | 可选包：GraphQL、微服务传输（Redis、NATS、gRPC） |
| 1.0 | API 冻结、性能基准、升级指南、长期支持策略 |

有想法或急需某个功能？欢迎提交 [Feature Request](https://github.com/penna-org/haze/issues/new/choose)。
