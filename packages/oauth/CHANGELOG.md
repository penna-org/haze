# @hazejs/oauth

## 1.2.0

### Minor Changes

- [#18](https://github.com/penna-org/haze/pull/18) [`76cba8b`](https://github.com/penna-org/haze/commit/76cba8b5cd7d540dd556b0389a86e3cc19f07f85) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - 整体 review 后的一轮安全加固、静默失效修复与性能优化。**以下几项改变了默认行为，升级前请对照：**
  
  **@hazejs/orm**
  
  - 批量赋值默认保护：`create(data)` / `save(data)` / `fill(data)` 不再接受已存在记录的主键、租户列、软删除列与乐观锁版本列（静默忽略）。新增 `static fillable` / `static guarded` 与 `forceFill()`；`allowField([...])` 显式列出的字段不受限制，直接给属性赋值也不受限制。
  - `Model.find(undefined | null)` 返回 `undefined`，不再返回第一行；不传参数的 `query().find()` 仍取第一条。
  - MongoDB：`where()` 的值是带 `$` 键的普通对象时抛错，运算符改用 `mongoOp({ ... })` 包裹或 `whereRaw(filter)`；批量赋值拒绝 `$` 开头或含 `.` 的键；`find(id)` 只接受 string / number / bigint / ObjectId。
  - 修复自关联的 `has()` / `hasWhere()` / `hasNot()` 结果错误、`cursor()` 在未选主键时死循环；`chunk()` 无排序时按主键排序，新增 `chunkById()`；`paginate()` 的 page / perPage 钳到 ≥ 1。
  - JSON 列原地修改现在计入脏检查；through 关联应用中间模型的软删除与租户条件；查询缓存键摘要由 32 位扩到 64 位；预加载分组由 O(n²) 改为 O(n)。
  
  **@hazejs/core**
  
  - `compress`：Brotli 默认 quality 由 11 降为 4（动态响应快两个数量级），新增 `level` 选项。
  - Session 改为滑动续期：只读请求在剩余有效期不足一半时续期。服务端存储驱动的 Cookie 格式变为 `<id>.<过期时间>.<签名>`，旧格式仍被接受；**回滚到旧版本会使新格式的 Cookie 失效**。
  - `cacheResponse` 的缓存键加入应用名、域名与语言，修复多应用 / 多域名下互串响应；升级后旧条目自然过期。
  - `POST /forgot-password` 恒返回 `{ status: 'sent' }`（不再返回 `throttled`），登录校验对不存在的用户补一次哈希比对，避免枚举账号。
  - `POST /tokens`：用个人访问令牌认证时，新令牌的能力不能超出当前令牌，省略时继承当前令牌的能力。
  - 调度：`work()` 不再被长任务阻塞后续分钟，单个任务的条件 / 加锁异常变为 `failed` 的运行记录而不是让循环停摆；需要互斥的任务请使用 `withoutOverlapping()`。
  - `schedule.runInServer` / `queue.runInServer` 在 Bun / Deno（含 `--compile` 二进制）下现在会启动。
  - `ctx.onResponse` 钩子与拦截器抛出的错误经 ExceptionHandler 上报并渲染；流式响应（SSE）结束后才释放请求容器；`dispose()` 逐步隔离错误；`boot()` 失败时清理已启动的资源并恢复全局 manager。
  - `Events.emit()` 的广播失败只记日志；`notify()` 逐个投递后再抛出（多个失败为 `AggregateError`）；批次投递中途失败会把未投递的任务记为失败；BullMQ 判定 stalled 的任务也会执行失败收尾，worker 连接错误不再被吞掉；维护模式下 `worker.stop()` 立即返回。
  - `Cache.remember()` 同进程并发未命中只回源一次；Redis Cluster 下 `flush()` 遍历所有主节点；非对称 JWT 密钥只导入一次；JSON 响应不再多做一次深遍历；维护状态改为 stale-while-revalidate。
  - Echo 的 WebSocket 连接器新增心跳（`heartbeat` 选项）与带抖动的重连退避；WebSocket 订阅受 `maxChannels` 限制；生产环境 2FA 使用内存存储时给出警告，同一用户的验证码校验串行执行。
  
  **@hazejs/graphql**
  
  - 修复深度 / 复杂度限制对片段的指数级展开（可被 1 KB 的查询拖死进程）；解析与校验结果按查询字符串缓存（自定义 `validationRules` 对同一查询只执行一次）。
  - 新增 `subscriptions.maxSubscriptionsPerConnection`（默认 100）与 PubSub 的 `maxBufferSize`（默认 1000）。
  
  **@hazejs/ai**
  
  - 修复 `streamText` 中工具调用失败导致的 unhandledRejection。
  - `toResponse()` 等响应被客户端取消时中止生成；断开后仍要生成到结束请先调用 `result.consume()`。
  - 流在没有结束标记时断开，现在输出可重试的 `APICallError`，不再报告为正常结束；OpenAI 兼容与 Google 的流内错误统一为 `APICallError`。
  - `streamObject` 对长输出节流部分解析。
  
  **@hazejs/oauth**
  
  - `OAuthUser` 新增 `emailVerified: boolean | null`，文档示例改为按 `(provider, id)` 关联账号、仅在 `emailVerified === true` 时按邮箱合并（Microsoft 恒为 `false`）。
  - 出站请求新增 `timeout`（默认 10 秒）；未知 `kid` 触发的 JWKS 强制刷新加 30 秒冷却。
  
  **@hazejs/socket.io**
  
  - 未配置 `socketio.cors` 且 `cors.origin` 未明确指定来源时，默认不再携带凭据（之前会反射任意来源并允许凭据）。跨域且依赖 Cookie 认证的部署需要显式配置来源。
  - 广播监听器的异常不再成为 unhandledRejection；握手认证创建的容器会被释放。
  
  **@hazejs/microservices**
  
  - NATS / Redis / gRPC 传输首次连接或加载失败后不再永久缓存失败结果，后续调用会重试。
  
  **@hazejs/search**
  
  - 事务内的索引同步推迟到提交后；`search:import` 按主键分批；修复 Typesense 过滤值中的反引号可以跳出字面量、注入过滤表达式（可绕过排在前面的租户等条件）：值里的反引号现在被去掉，字段名只允许字母、数字、下划线、点与连字符，每个条件加括号。
  
  **@hazejs/vite / @hazejs/cli / create-hazejs**
  
  - 模板的 `.gitignore` 忽略 `.env`，并附带 `.env.example`（之前生成的 `APP_KEY` 会被 `git add .` 提交）。**已有项目请自行把 `.env` 加入 `.gitignore`，若已提交过请用 `haze key:generate --force` 更换密钥。**
  - `haze build --minify` 后不再漏掉运行时外部依赖；binary 预设下载原生模块时校验 `dist.integrity`；一次性 CLI 命令不再启动文件监听。

### Patch Changes

- Updated dependencies [[`76cba8b`](https://github.com/penna-org/haze/commit/76cba8b5cd7d540dd556b0389a86e3cc19f07f85)]:
  - @hazejs/core@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [[`e642b2e`](https://github.com/penna-org/haze/commit/e642b2e6f5f48126068df6b3862035238d57e501)]:
  - @hazejs/core@1.1.0

## 1.0.0

### Major Changes

- [#14](https://github.com/penna-org/haze/pull/14) [`80169cf`](https://github.com/penna-org/haze/commit/80169cf2ae0ad9159fe1dc50d71a845c6fb91a6b) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - hazejs 1.0, the first stable release. All `@hazejs/*` packages and `create-hazejs` share version 1.0.0 and follow semantic versioning from here on: breaking changes only land in a new major, with an upgrade guide.
  
  Security fixes included in this release:
  
  - **Rate limiting behind proxies.** With `app.trustProxy`, `ctx.ip` is now the `X-Forwarded-For` entry appended by the nearest trusted proxy (the rightmost) instead of the leftmost one, which the client can set itself; previously a client could get a fresh `throttle` bucket per request by sending its own `X-Forwarded-For`. `trustProxy` also accepts the number of trusted hops (`trustProxy: 2` behind a CDN and a load balancer). The Cloudflare Workers entry passes `cf-connecting-ip` and the AWS Lambda adapter passes the event's `sourceIp` as the client address, so on those platforms `ctx.ip` works without `trustProxy` and `throttle` no longer counts every anonymous request under one shared key. New `setClientAddress(request, ip)` export for custom entries; `throttle` logs a warning once when no client address is known.
  - **Two-factor login lockout.** Wrong codes are counted per user in the cache (new `twoFactor.cacheStore` option, default store) for `challengeTtl`, not in the session cookie the client holds, so replaying the login cookie no longer resets `maxAttempts`. After `maxAttempts` wrong codes the user cannot complete a challenge until `challengeTtl` has passed, even after entering the password again.
  - **Passkey challenges.** In `challenge: 'session'` mode a used challenge is also recorded in the cache, so an old session cookie cannot replay a registration or authentication response.
  
  Packaging: `@hazejs/cli` depends on `@hazejs/vite` with a caret range instead of an exact version, every package has `main` / `types` fallbacks for older module resolution, and `@hazejs/microservices` declares the legacy `nats` client as an optional peer dependency.

### Patch Changes

- Updated dependencies [[`80169cf`](https://github.com/penna-org/haze/commit/80169cf2ae0ad9159fe1dc50d71a845c6fb91a6b)]:
  - @hazejs/core@1.0.0

## 0.5.0

### Patch Changes

- Updated dependencies [[`57b3b34`](https://github.com/penna-org/haze/commit/57b3b34daf04d05252f6fc5e0cd059b6676ca116)]:
  - @hazejs/core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`a7d7a1b`](https://github.com/penna-org/haze/commit/a7d7a1b2c351570511883fe28cc743e2b86f5c0f)]:
  - @hazejs/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`7b5e0a9`](https://github.com/penna-org/haze/commit/7b5e0a95b73edbeac5aa5570483b2cbe2daf2eb8), [`cb51e0a`](https://github.com/penna-org/haze/commit/cb51e0aa95ad258aee8cc11e41cabe09448c01de), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`f46d960`](https://github.com/penna-org/haze/commit/f46d960fb67f600e402f3ba371f83c3a8f3592cb), [`ea86d01`](https://github.com/penna-org/haze/commit/ea86d0175adf24563dc62ce796e602a04fbe6dcd), [`940711c`](https://github.com/penna-org/haze/commit/940711c72b493eab636beb0fd034ff8f118165bc), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`4da85a8`](https://github.com/penna-org/haze/commit/4da85a83107181f99b029837798be84cb7c8c92a), [`bd81767`](https://github.com/penna-org/haze/commit/bd817672b975e2475a7644214396915d5f247f9b), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`15e802d`](https://github.com/penna-org/haze/commit/15e802d5f341a9928720189ed49a9cba8ff168f2), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4)]:
  - @hazejs/core@0.3.0

## 0.2.0

### Minor Changes

- [`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Authentication extensions. New package `@hazejs/oauth` for social login (GitHub, Google, Apple, Microsoft, GitLab, Discord, WeChat, WeChat Official Accounts, QQ, DingTalk, Feishu / Lark, WeCom, Alipay and any OpenID Connect provider) with state, PKCE, nonce and `id_token` verification. Core adds personal access tokens (`token` guard, `ctx.auth.tokenCan()`, `abilities:` / `ability:` middleware), signed email verification (`sendEmailVerification()`, `verifyEmail()`, `verified` middleware), password reset (`PasswordReset.sendLink()` / `reset()`), TOTP two-factor authentication with recovery codes and a session challenge flow (`TwoFactor`), passkeys on top of the optional `@simplewebauthn/server` (`Passkeys`) and an `authRoutes()` helper. `@hazejs/orm` adds database stores for all of them, and `haze make:auth-tables` generates their schema. New projects include token, email verification, password reset and GitHub login endpoints.

### Patch Changes

- Updated dependencies [[`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450), [`1feefd3`](https://github.com/penna-org/haze/commit/1feefd347c59e86ddbb215b0cddb28172a6bce75), [`704870c`](https://github.com/penna-org/haze/commit/704870c8282875ad5a2d81012a96049e31e77b59), [`d9523dc`](https://github.com/penna-org/haze/commit/d9523dce1bb88b486d6ba78a41d7760c9d57b70a), [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671), [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4), [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac), [`8437ae9`](https://github.com/penna-org/haze/commit/8437ae94e16fef8c96ba64e96fbfad4946c75eec), [`175e253`](https://github.com/penna-org/haze/commit/175e253f1f42dd5466a7c4409c46b04939bbebce), [`b0eaecc`](https://github.com/penna-org/haze/commit/b0eaeccea3472d7b8d095e2f9cc66706c35b8d56), [`743e0c6`](https://github.com/penna-org/haze/commit/743e0c646b305b1532357fe09a51e6665ac8fb33)]:
  - @hazejs/core@0.2.0
