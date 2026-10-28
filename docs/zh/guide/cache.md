# 缓存

hazejs 的缓存内置在 `@hazejs/core` 中：几个精简的驱动（内存、Redis、Upstash、Cloudflare KV）、一个带有 Laravel 风格方法的 `Cache` 门面、原子锁，以及响应缓存中间件。多实例部署时，[限流与 Session](./security) 也可以共用这些存储。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 配置

存储在 `config/cache.ts` 中声明。没有这个文件时，框架只提供一个内存存储，键前缀为 `haze:`。

```ts
// config/cache.ts
import { defineCacheConfig, env } from '@hazejs/core'

export default defineCacheConfig(() => ({
  default: env('CACHE_STORE', 'memory'),
  // 多个应用共用一个 Redis 时用前缀区分
  prefix: env('CACHE_PREFIX', 'my-app:'),
  stores: {
    memory: { driver: 'memory' },
    redis: {
      driver: 'redis',
      url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
    },
    upstash: {
      driver: 'upstash',
      url: env('UPSTASH_REDIS_REST_URL', ''),
      token: env('UPSTASH_REDIS_REST_TOKEN', ''),
    },
    kv: { driver: 'kv', binding: 'CACHE' },
  },
  // cacheResponse 中间件使用的存储（默认为 default）
  responseStore: 'redis',
}))
```

| 选项 | 说明 |
| --- | --- |
| `default` | `Cache` 门面使用的默认存储名 |
| `prefix` | 所有键的前缀；`flush()` 只清理该前缀下的键。默认 `haze:` |
| `stores` | 按名字声明的存储 |
| `responseStore` | `cacheResponse` 使用的存储，默认为 `default` |

## 驱动

| 驱动 | 依赖 | 原子性 | 可在 Edge 运行 | 适用场景 |
| --- | --- | --- | --- | --- |
| `memory` | — | 是 | 是（每个 isolate 独立） | 开发、单实例 |
| `redis` | `ioredis` | 是 | 否（TCP） | 多实例的 Node / Bun / Docker / Lambda |
| `upstash` | `@upstash/redis` | 是 | 是（HTTP） | Vercel、Netlify、Workers |
| `kv` | —（Workers 绑定） | 否 | 仅 Cloudflare | Workers 上的缓存与 Session |
| `custom` | — | 取决于实现 | 取决于实现 | 任何实现了 `CacheStore` 的存储 |

- **redis**：可传 `url`、`options`（透传给 ioredis），或直接传入已创建的 `client`（Cluster / Sentinel 场景）。自增与锁的释放都用 Lua 脚本完成。安装：`pnpm add ioredis`。
- **upstash**：需要 `url` 与 `token`。安装：`pnpm add @upstash/redis`。
- **kv**：读取 `binding` 指定的 Workers 绑定（默认 `CACHE`）。KV 是最终一致的，TTL 最短 60 秒（更短的有效期通过元数据判断），`add` / `increment` 是先读后写。在 KV 上创建锁会直接报错。
- **custom**：写成 `{ driver: 'custom', store }`，`store` 实现 `@hazejs/core` 导出的 `CacheStore` 接口（`get`、`set`、`add`、`delete`、`increment`、`deleteIf`、`clear`，以及 `driver` 与 `atomic`）。

::: warning KV 不保证原子性
KV 只适合做缓存和 Session。Workers 上需要精确计数、限流或锁时，请使用 Upstash；限流也可以使用 Cloudflare Rate Limiting 绑定（见 [Session、CSRF 等](./security)）。
:::

## 基本用法

```ts
import { Cache } from '@hazejs/core'

await Cache.set('greeting', { text: 'hi' }, '10m')
const greeting = await Cache.get<{ text: string }>('greeting')
const name = await Cache.get('name', 'guest') // 默认值
const lazy = await Cache.get('name', () => loadName()) // 默认值函数

const stats = await Cache.remember('stats', '10m', () => computeStats())
const settings = await Cache.rememberForever('settings', () => loadSettings())

await Cache.increment('views') // 原子自增，从 0 开始
await Cache.decrement('stock', 2)
await Cache.store('redis').get('key') // 指定存储
```

| 方法 | 说明 |
| --- | --- |
| `get(key, fallback?)` | 读取；`fallback` 可以是值，也可以是（异步）函数 |
| `many(keys)` | 一次读取多个键，返回对象 |
| `has(key)` | 键是否存在 |
| `set(key, value, ttl?)` | 写入；不传 TTL 表示永久 |
| `setMany(values, ttl?)` | 批量写入 |
| `add(key, value, ttl?)` | 不存在时才写入，返回是否写入 |
| `forget(key)` | 删除 |
| `pull(key)` | 读取并删除 |
| `remember(key, ttl, fn)` | 有缓存就返回，否则执行 `fn` 并写入（返回 `undefined` 时不缓存） |
| `rememberForever(key, fn)` | 永不过期的 `remember` |
| `increment(key, by?, ttl?)` | 原子自增；TTL 只在键新建时设置 |
| `decrement(key, by?, ttl?)` | 原子自减 |
| `flush()` | 删除当前前缀下的全部键 |
| `lock(name, ttl?, owner?)` / `restoreLock(name, owner)` | 原子锁，见下文 |
| `store(name?)` | 切换存储，返回拥有相同方法的仓库对象 |

值以 JSON 序列化，因此 `Date` 读回来是字符串。

### TTL 写法

TTL 可以是秒数，也可以是带单位的字符串：`'30s'`、`'10m'`、`'2h'`、`'7d'`。省略则永久保存。

## 原子锁

锁通过原子的"不存在才写入"获取，持有者标识是一个随机值，到期（默认 60 秒）后自动释放。`memory`、`redis`、`upstash` 支持锁；在 `kv` 上创建锁会抛错。

```ts
import { Cache, LockTimeoutException } from '@hazejs/core'

// 拿到锁后执行，结束后释放；锁被占用时抛 LockTimeoutException
await Cache.lock('report', '30s').run(() => generateReport())

// 最多等待 5 秒
await Cache.lock('report', '30s').run(() => generateReport(), 5)

// 手动控制
const lock = Cache.lock('import', 120)
if (await lock.get()) {
  try {
    await runImport()
  }
  finally {
    await lock.release()
  }
}
```

- `get()`：尝试一次，返回 boolean。
- `block(seconds, interval?)`：默认每 250ms 重试一次，超时抛 `LockTimeoutException`。
- `release()`：只有持有者才能释放。
- 跨进程释放：把 `lock.owner` 传给另一个进程，用 `Cache.restoreLock(name, owner)` 恢复后释放。

::: tip
`remember()` 不防缓存击穿：并发未命中时每个请求都会计算一次。计算代价高时可以配合锁使用。
:::

## 响应缓存

内置中间件 `cacheResponse` 按路径与查询参数缓存成功的 `GET` / `HEAD` 响应：

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { FeedController } from '~/app/controller/FeedController'
import { StatsController } from '~/app/controller/StatsController'

export default defineRoutes((r) => {
  r.get('/api/stats', [StatsController, 'index']).middleware('cacheResponse:60')
  // 按当前登录用户分别缓存
  r.get('/api/me/feed', [FeedController, 'index']).middleware('cacheResponse:5m,user')
})
```

- 只缓存 `200` 响应；带 `Cache-Control: no-store` 或 `private` 的响应会被跳过，缓存副本不包含 `Set-Cookie`。
- 响应头带 `X-Cache: MISS` 或 `X-Cache: HIT`，命中时还会带 `Age`。
- 缓存写入 `config/cache.ts` 的 `responseStore`。命名中间件的使用方式见 [中间件](./middleware)。

## 限流与 Session 共享存储

多实例部署时，让限流与 Session 使用同一个原子存储，计数和会话数据就能在实例间共享：

```ts
// config/throttle.ts
import { defineThrottleConfig, env } from '@hazejs/core'

export default defineThrottleConfig(() => ({
  store: env('CACHE_STORE', 'memory'),
  limiters: {
    api: { max: 60, window: '1m' },
  },
}))
```

Session 使用 `{ driver: 'cache', store: 'redis' }`。详见 [Session、CSRF 等](./security)。

## 注入缓存管理器

`Cache` 门面背后是应用的 `CacheManager`，也可以直接注入（见 [服务容器](./container)）：

```ts
// app/service/StatsService.ts
import { CacheManager, inject } from '@hazejs/core'

export class StatsService {
  private cache = inject(CacheManager)

  summary() {
    return this.cache.store('redis').remember('stats:summary', '1h', () => this.compute())
  }
}
```

`manager.store(name?)` 返回 `CacheRepository`，方法与门面一致。
