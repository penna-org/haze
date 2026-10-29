# 维护模式

应用处于“维护中”时，所有请求都返回 503，不会进入路由：API 客户端收到统一的错误格式，浏览器看到简洁的维护页面。健康检查照常响应，负载均衡不会摘除实例；你也可以用密钥绕过维护访问应用。

```sh
npx haze down --secret=let-me-in --retry=60
npx haze up
```

生产环境不需要命令行工具：

```sh
node dist/worker.mjs down --secret=let-me-in
node dist/worker.mjs up
node dist/worker.mjs maintenance:status
```

运行中的服务、队列 worker 与定时任务在两秒内生效，无需重启——`haze dev` 也一样。

## 状态保存在哪里

`haze down` 写入一份很小的 JSON 状态（时间、状态码、Retry-After、密钥的哈希等），各进程读取它。默认保存在默认的 [缓存存储](./cache) 中，共用同一存储的所有实例看到相同的状态：

```ts
// config/maintenance.ts
import { defineMaintenanceConfig } from '@hazejs/core'

export default defineMaintenanceConfig({
  driver: 'cache', // 'cache'（默认）或 'file'
  store: 'redis', // config/cache.ts 中的存储，默认为缓存的默认存储
  // file: 'storage/framework/down', // driver: 'file' 时的文件，相对项目根目录
})
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `driver` | `'cache'` | `'cache'` 或 `'file'` |
| `store` | 缓存的默认存储 | `cache` 驱动使用的缓存存储 |
| `key` | `'framework:down'` | 缓存键（会加上缓存前缀） |
| `file` | `'storage/framework/down'` | `file` 驱动的状态文件 |
| `interval` | `2000` | 各进程缓存状态的毫秒数，`haze up` 最多在这段时间后到达所有进程 |
| `except` | `[]` | 始终放行的路径，与 `--except` 合并 |
| `pauseWorkers` | `true` | 维护期间暂停队列 worker、跳过定时任务 |
| `workerSleep` | `3000` | 暂停中的 worker 检查状态的间隔（毫秒） |
| `cookie` | `'haze_maintenance'` | 绕过 Cookie 的名称 |
| `bypassTtl` | `43200` | 绕过 Cookie 的有效期（秒，12 小时） |

::: warning 进程内的 memory 存储
`memory` 缓存存储（模板的默认值）只存在于单个进程中，另一个进程执行的 `haze down` 无法影响到服务。因此存储为 `memory` 时，状态改为保存在 `storage/framework/down`（测试中除外，测试使用内存以保证用例之间互相隔离），`haze down` 会给出提示。多台机器请使用 `redis` 等共享存储；`file` 只影响写入它的那台机器。
:::

## 选项

| 选项 | 说明 |
| --- | --- |
| `--secret=<s>` | 绕过密钥：访问 `/<s>` 后设置 Cookie 并跳转到 `/`，之后该浏览器可以正常使用应用。只能包含字母、数字、`-` 与 `_` |
| `--with-secret` | 生成随机密钥并打印出来 |
| `--retry=60` | `Retry-After` 响应头（秒，默认 60） |
| `--refresh=15` | `Refresh` 响应头：浏览器在这么多秒后自动刷新 |
| `--status=503` | 状态码（默认 503） |
| `--redirect=/maintenance` | 浏览器请求重定向到该路径（该路径本身显示维护页；要由自己的路由处理，把它加入 `--except`） |
| `--render=Maintenance` | 渲染 `app/view/Maintenance.tsx`，代替内置页面 |
| `--except=/api/webhooks/*,/status` | 放行的路径，逗号分隔，`*` 匹配任意字符 |
| `--message="10 点恢复"` | 页面与 JSON 响应中的提示，可以是翻译键 |

`haze maintenance:status` 显示当前状态。所有命令都支持 `--root`。

## 响应

- **JSON**：不接受 `text/html` 的请求，以及 `/api` 下的所有路径，返回带真实状态码的错误格式：

  ```json
  { "code": 503, "message": "The application is down for maintenance. Please check back soon.", "data": null }
  ```

  配置了 [`config/i18n.ts`](./localization) 时，消息按 `http.maintenance` 翻译（zh-CN：`系统正在维护，请稍后再访问。`），可在 `lang/<locale>/http.ts` 中覆盖。

- **HTML**：浏览器得到内置的独立页面（不依赖外部资源，支持深色模式）、`--render` 指定的视图，或重定向。

所有响应都带有 `Retry-After`、设置了时的 `Refresh`，以及 `Cache-Control: no-store`。

### 自定义页面

视图收到 `{ status, title, message, lang, retry, refresh, state }`：

```tsx
// app/view/Maintenance.tsx —— haze down --render=Maintenance
export default function Maintenance(props: { title: string, message: string, retry?: number }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <title>{props.title}</title>
      </head>
      <body>
        <h1>马上回来</h1>
        <p>{props.message}</p>
      </body>
    </html>
  )
}
```

视图不存在或渲染失败时使用内置页面，并记录警告。详见 [视图](./views)。

## 哪些请求仍然放行

- `except` 中的路径（配置与 `--except`）。
- [健康检查](./observability#health-checks)（`/health`、`/health/ready`、`/health/live`）。
- 开发时的开发面板 `/__haze`。
- 带有效绕过 Cookie 的请求。Cookie 用 `APP_KEY` 签名，`bypassTtl` 后过期，并且只对签发它的那一次维护有效：新的 `haze down --secret` 会使它失效。

密钥本身以 SHA-256 哈希保存。中间件紧跟在请求作用域之后，先于静态资源、OpenAPI 文档、健康检查与全局中间件，因此维护期间不会执行认证或 CSRF 等逻辑。

全栈项目开发时，只有 `/api/**` 会交给后端，前端由 Vite 提供，不受影响。生产环境中前端文件也由后端托管，因此同样会被拦截——自定义页面需要这些文件时，把 `/assets/*` 加入 `except`。

## 队列 worker 与定时任务

`pauseWorkers: true`（默认）时，队列 worker 先完成正在执行的任务，然后在任务之间等待，直到应用恢复，每隔 `workerSleep` 毫秒检查一次。到期的定时任务被跳过，原因为 `maintenance`。这适用于 `haze queue:work`、`haze schedule:*`、`worker.mjs queue` / `schedule` 以及进程内的 memory 队列。

## 在代码中使用

```ts
import { Maintenance } from '@hazejs/core'

const { secret } = await Maintenance.down({ withSecret: true, retry: 120 })
await Maintenance.isDown()
await Maintenance.up()
```

`MaintenanceModeEnabled` 与 `MaintenanceModeDisabled` 是在执行 `down()` / `up()` 的进程中触发的 [事件](./events)：

```ts
// app/listener/NotifyOps.ts
import { defineListener, MaintenanceModeEnabled } from '@hazejs/core'

export default defineListener(MaintenanceModeEnabled, ({ state }) => {
  console.log(`down since ${new Date(state.time).toISOString()}`)
})
```

## Serverless 与边缘

没有可写的项目目录或常驻进程的平台（Cloudflare Workers、Vercel、Netlify、Lambda）需要使用 `cache` 驱动与共享存储——Workers 上用 KV，其它平台用 Upstash 或 Redis。这些平台没有 `worker.mjs`，需要直接设置存储中的状态：在配置了同一存储的机器上执行 `haze down`（例如 `.env` 中有 Upstash 的凭据），或者直接写入键：

```sh
# Cloudflare KV：<缓存前缀>framework:down
wrangler kv key put --binding CACHE "haze:framework:down" '{"time":0,"status":503,"retry":60}'
wrangler kv key delete --binding CACHE "haze:framework:down"
```

KV 是最终一致的，可能需要一分钟左右才能到达所有节点。

另见 [部署](./deployment#maintenance-mode)。
