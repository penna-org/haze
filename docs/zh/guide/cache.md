# 缓存

hazejs 的缓存内置在 `@hazejs/core` 中：内存、Redis、Upstash 与 Cloudflare KV 几种驱动，统一通过 `Cache` 门面使用。接口沿用 ThinkPHP 的写法（`Cache.set`、`Cache.get`、`Cache.inc`、`Cache.tag`、`cache()`），Laravel / PSR-16 的方法名同样可用。此外还有标签缓存、带类型的 Redis 哈希 / 列表 / 集合 / 有序集合、原子锁与响应缓存中间件。多实例部署时，[限流与 Session](./security) 也可以共用这些存储。

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
    // config/redis.ts 中的连接（缺省为其 default 连接，即 REDIS_URL）
    redis: { driver: 'redis', connection: 'default' },
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
| `default` | `Cache` 门面与 `cache()` 使用的默认存储名 |
| `prefix` | 所有键的前缀；`clear()` 只清理该前缀下的键。默认 `haze:` |
| `stores` | 按名字声明的存储 |
| `responseStore` | `cacheResponse` 使用的存储，默认为 `default` |
| `serializer` | `'typed'`（默认）、`'json'` 或自定义序列化器，每个存储可以单独覆盖。见 [序列化](#序列化) |

存储名与驱动会进入生成的配置类型：`Cache.store('redis')` 的类型就是 Redis 存储，存储名拼错时类型检查报错（见 [类型](#类型)）。

## 驱动

| 驱动 | 依赖 | 原子性 | 可在 Edge 运行 | 适用场景 |
| --- | --- | --- | --- | --- |
| `memory` | — | 是 | 是（每个 isolate 独立） | 开发、测试、单实例 |
| `redis` | `ioredis` | 是 | 否（TCP） | 多实例的 Node / Bun / Docker / Lambda |
| `upstash` | `@upstash/redis` | 是 | 是（HTTP） | Vercel、Netlify、Workers |
| `kv` | —（Workers 绑定） | 否 | 仅 Cloudflare | Workers 上的缓存与 Session |
| `custom` | — | 取决于实现 | 取决于实现 | 任何实现了 `CacheStore` 的存储 |

- **redis**：使用 [`config/redis.ts`](./redis) 中的命名连接（`connection`，默认为 `default` 连接，读取 `REDIS_URL`），存储运行在该连接的共享命令连接上，Cluster、Sentinel 与 TLS 都在那里配置。连接的 `keyPrefix` 加在缓存 `prefix` 之前，`clear()` 会处理它。原来的内联写法仍然可用并且优先：`url`（`options` 透传给 ioredis）或直接传入已创建的 ioredis `client`。自增、`push` 与锁的释放都用 Lua 脚本完成。安装：`pnpm add ioredis`。
- **upstash**：需要 `url` 与 `token`。安装：`pnpm add @upstash/redis`。
- **kv**：读取 `binding` 指定的 Workers 绑定（默认 `CACHE`）。KV 是最终一致的，TTL 最短 60 秒（更短的有效期通过元数据判断），`add` / `increment` / `push` 是先读后写。在 KV 上创建锁会直接报错。
- **custom**：写成 `{ driver: 'custom', store }`，`store` 实现 `@hazejs/core` 导出的 `CacheStore` 接口：`get`、`set`、`add`、`delete`、`increment`、`deleteIf`、`clear`，以及 `driver` 与 `atomic`。可选的 `ttl`、`touch`、`push`、`handler`、`commands`、`tags` 实现后即可使用对应功能。

各驱动支持哪些功能见 [驱动能力对比](#驱动能力对比)。

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

await Cache.has('greeting')
await Cache.delete('greeting')
const flash = await Cache.pull('flash') // 读取并删除

const stats = await Cache.remember('stats', '10m', () => computeStats())
const settings = await Cache.rememberForever('settings', () => loadSettings())

await Cache.inc('views') // 原子自增，从 0 开始
await Cache.dec('stock', 2)
await Cache.push('recent', { id: 7 }) // 向数组缓存追加一项

await Cache.store('redis').get('key') // 指定存储
await Cache.clear() // 清空当前存储前缀下的全部键
```

| 方法 | 别名 | 说明 |
| --- | --- | --- |
| `get(key, fallback?)` | | 读取；`fallback` 可以是值，也可以是（异步）函数 |
| `getMultiple(keys)` | `many` | 一次读取多个键，返回对象 |
| `has(key)` | | 键是否存在 |
| `set(key, value, ttl?)` | | 写入；不传 TTL 表示永久 |
| `setMultiple(values, ttl?)` | `setMany` | 批量写入 |
| `add(key, value, ttl?)` | | 不存在时才写入，返回是否写入 |
| `delete(key)` | `forget` | 删除，返回键原来是否存在 |
| `deleteMultiple(keys)` | `deleteMany` | 删除多个键，返回实际删除的个数 |
| `pull(key)` | | 读取并删除 |
| `remember(key, ttl, fn)` | | 有缓存就返回，否则执行 `fn` 并写入（返回 `undefined` 时不缓存） |
| `rememberForever(key, fn)` | | 永不过期的 `remember` |
| `inc(key, by?, ttl?)` | `increment` | 原子自增；TTL 只在键新建时设置 |
| `dec(key, by?, ttl?)` | `decrement` | 原子自减 |
| `push(key, value, ttl?)` | | 向数组缓存追加一项，不存在时新建，见 [push](#push) |
| `ttl(key)` | | 剩余秒数：永久为 `undefined`，不存在为 `null` |
| `touch(key, ttl?)` | `expire` | 只修改有效期、不改写值（省略 `ttl` 为改成永久），返回键是否存在 |
| `clear()` | `flush` | 删除当前前缀下的全部键 |
| `tag(names)` | | [标签缓存](#标签) |
| `handler()` | | [底层客户端](#底层客户端) |
| `lock(name, ttl?, owner?)` / `restoreLock(name, owner)` | | [原子锁](#原子锁) |
| `store(name?)` | | 切换存储，返回拥有相同方法的仓库对象 |
| `redis(name?)` | | 带 [Redis 数据结构](#redis-数据结构) 的存储，其它驱动会报错 |

别名就是同一个方法，按团队习惯选用即可。

### TTL 写法

TTL 可以是秒数，也可以是带单位的字符串：`'30s'`、`'10m'`、`'2h'`、`'7d'`。省略则永久保存。

### 剩余时间与续期

```ts
await Cache.set('report', data, '1h')
await Cache.ttl('report') // 3600
await Cache.touch('report', '1d') // 续期，不改写值
await Cache.expire('report') // 改为永久
await Cache.ttl('missing') // null
```

### push

`push` 向数组缓存末尾追加一个值，键不存在时新建 `[value]`；原值不是数组时抛 `TypeError`。不传 TTL 时保留原来的有效期（新建的为永久），传了则重新设置。

`memory`、`redis`、`upstash` 上的 `push` 是原子的，并发追加不会丢项。Redis 上用一个 Lua 脚本把编码好的元素直接拼到已存 JSON 数组的末尾（`SETRANGE`），不解析原值，因此值仍是普通字符串，`get()` 读到的就是数组。`kv` 以及自定义序列化器为先读后写。

与 ThinkPHP 不同，`push` 不去重，也不限制最多 1000 项。列表很长或需要经常裁剪时，请使用 [Redis 列表](#redis-数据结构)。

## ThinkPHP 写法对照

| ThinkPHP | hazejs | 说明 |
| --- | --- | --- |
| `Cache::set('name', $value, 3600)` | `await Cache.set('name', value, 3600)` | TTL 也可以写成 `'1h'` |
| `Cache::get('name', 'default')` | `await Cache.get('name', 'default')` | |
| `Cache::has / delete / pull` | `Cache.has / delete / pull` | |
| `Cache::inc('name', 3)` / `Cache::dec(...)` | `Cache.inc('name', 3)` / `Cache.dec(...)` | memory、redis、upstash 上是原子的 |
| `Cache::push('name', $value)` | `Cache.push('name', value)` | 不去重，没有 1000 项上限 |
| `Cache::remember('name', fn, 3600)` | `Cache.remember('name', 3600, fn)` | TTL 在回调**之前** |
| `Cache::clear()` | `Cache.clear()` | 只清理本应用前缀下的键 |
| `Cache::getMultiple / setMultiple / deleteMultiple` | 同名 | |
| `Cache::store('redis')` | `Cache.store('redis')` | 按驱动推导类型 |
| `Cache::tag('t')->set(...)` / `->clear()` | `Cache.tag('t').set(...)` / `.clear()` | 需要用同一组标签读取（见 [标签](#标签)） |
| `Cache::tag('t')->append('name')` | — | 不支持 |
| `Cache::handler()` | `await Cache.handler()` | |
| `Cache::store('redis')->handler()->hSet(...)` | `Cache.redis().hash(key).set(...)` | 带类型、前缀与序列化 |
| `cache('name')` / `cache('name', $v, 3600)` / `cache('name', null)` | 相同 | 见 [下文](#cache-助手函数) |

## `cache()` 助手函数

```ts
import { cache } from '@hazejs/core'

await cache('greeting', { text: 'hi' }, '10m') // 写入
const greeting = await cache<{ text: string }>('greeting') // 读取
await cache('greeting', null) // 删除
await cache().remember('stats', '1h', compute) // 默认存储的仓库对象
```

助手函数始终使用默认存储。只有 `null` 表示删除；`cache(key, undefined)` 与 `Cache.set` 一样写入 `null`。

## 标签

标签把一组缓存归在一起，方便统一失效：

```ts
await Cache.tag('user').set('user:1', user, '1h')
await Cache.tag(['user', 'post']).set('feed:1', feed)

await Cache.tag('user').get('user:1')
await Cache.tag(['post', 'user']).remember('feed:2', '10m', () => buildFeed(2)) // 标签顺序无关

await Cache.tag('user').clear() // 清除 user:1，以及同样带 user 标签的 feed:1
await Cache.store('redis').tag('user').clear() // 指定存储上的标签
```

标签缓存支持 `get`、`set`、`add`、`has`、`delete`、`many`、`pull`、`remember`、`rememberForever`、`inc` / `dec`、`push`、`ttl`、`touch` 与 `clear()`。`Cache.tag('a').tag('b')` 等同于 `Cache.tag(['a', 'b'])`。

实现方式：每个标签有一个版本号，存在 `<prefix>tag:<name>:version`；带标签的值放在由其全部标签的版本号决定的命名空间中，`clear()` 给这些标签换上新版本号，带有其中任一标签的值从此都读不到了。这种方式在所有驱动上都可用，包括 KV。`redis` 驱动另外为每个标签记录它下面的键，`clear()` 时立即删除以释放内存；其它驱动上被清除的值会留到过期为止，所以在这些驱动上最好给带标签的值设置 TTL。

::: warning 用同一组标签读取
带标签的值只能通过写入时的同一组标签读到：`Cache.tag(['user', 'post']).set('feed', ...)` 写入的值，用 `Cache.get('feed')` 或 `Cache.tag('user').get('feed')` 都读不到。Laravel 也是如此；ThinkPHP 则把带标签的值存在原来的键下，标签只用于清除。
:::

标签版本号位于存储前缀与 [租户前缀](./tenancy) 之下，一个应用或租户清除标签不会影响其它应用或租户。`tag:*`、`tagged:*` 与 `lock:*` 这几类键为保留键。

## Redis 数据结构

驱动为 `redis` 的存储提供带类型的哈希、列表、集合与有序集合句柄。键同样带缓存前缀与租户前缀，每个元素都经过与 `get` / `set` 相同的 [序列化器](#序列化)，有序集合的分数保持数字。

```ts
import { Cache } from '@hazejs/core'

const redis = Cache.redis() // 或 Cache.store('redis')，类型由 config/cache.ts 推导

// 哈希
const user = redis.hash('user:1')
await user.set('name', 'Ada')
await user.set({ email: 'ada@example.com', visits: 0 }, '1h')
await user.increment('visits')
await user.all() // { name: 'Ada', email: '...', visits: 1 }

// 列表
const recent = redis.list<{ id: number }>('recent', '1d')
await recent.push({ id: 1 }, { id: 2 })
await recent.trim(-100, -1) // 只保留最后 100 项
await recent.range(0, 9)

// 集合（setOf() 可以带 TTL）
await redis.set('online').add('u1', 'u2')
await redis.setOf('online', '5m').has('u1')

// 有序集合（别名 zset）
const board = redis.sortedSet('scores')
await board.add('ada', 42)
await board.add({ bob: 7, cy: 19 })
await board.increment('bob', 5)
await board.top(10) // [{ member: 'ada', score: 42 }, ...]
await board.rank('ada', { reverse: true }) // 0
```

| 结构 | 方法 |
| --- | --- |
| `hash(key, ttl?)` | `get(field)`、`set(field, value, ttl?)`、`set(record, ttl?)`、`all()`、`has(field)`、`delete(...fields)`、`increment(field, by?)`、`decrement`、`keys()`、`values()`、`length()` |
| `list(key, ttl?)` | `push(...values)`（RPUSH）、`unshift(...values)`（LPUSH）、`pop()`、`shift()`、`range(start?, stop?)`、`all()`、`length()`、`trim(start, stop)`、`remove(value, count?)` |
| `set(key)` / `setOf(key, ttl?)` | `add(...members)`、`remove(...members)`、`has(member)`、`members()`、`size()`、`pop(count?)`、`random(count?)` |
| `sortedSet(key, ttl?)` / `zset` | `add(member, score, ttl?)`、`add(record)`、`add([[member, score], ...], ttl?)`、`increment(member, by?)`、`score(member)`、`rank(member, { reverse })`、`range(start?, stop?, { reverse, withScores })`、`top(n)`、`rangeByScore(min, max, { reverse, withScores, limit })`、`remove(...members)`、`size()` |
| 所有句柄 | `expire(ttl?)`、`ttl()`、`exists()`、`drop()`；列表、集合与有序集合另有 `delete()` |

- **TTL** 作用于整个键。在创建句柄时传入（`redis.list('recent', '1d')`），每次写入后都会在同一个 `MULTI` 事务中设置；`hash.set` 与 `sortedSet.add` 也可以直接传 TTL；`expire()` / `ttl()` 随时可以在句柄上调用。
- **`set(key)` 只传一个参数**时返回集合句柄；传入值时仍是普通的写缓存 `set(key, value, ttl?)`。需要带 TTL 的集合请用 `setOf(key, ttl)`。
- **哈希字段**用 `delete(field, ...fields)` 删除；删除整个哈希用 `drop()`。
- **集合成员**按序列化后的字符串比较，对象成员的键顺序需要一致。
- **有序集合的成员**是数组时必须用 entries 写法 `add([[member, score]])`；只传一个对象参数时视为 `{ 成员: 分数 }` 的记录。
- `rangeByScore` 的边界可以是数字、`'-inf'`、`'+inf'` 与 `'(5'`（不含 5）。
- 用 `get()` 读取数据结构的键会像 Redis 一样报 `WRONGTYPE`。

这里没有覆盖的命令，可以用 `redis.command(key, 'zunionstore', ...)`（自动加前缀、带遥测），或从 `handler()` 取原始客户端。什么时候用这些数据结构、什么时候用 `Redis` 门面，见 [Redis](./redis#缓存数据结构还是-redis-门面)。

### 在测试中使用

`memory` 存储在进程内模拟了同样的数据结构，返回值相同，结构为空时同样删除键。测试中把 `redis` 存储改成 memory，使用 `Cache.redis()` 的代码不需要 Redis 服务也能运行：

```ts
// 测试配置
cache: { stores: { redis: { driver: 'memory' } } }
```

这套模拟只为测试准备：仅限单个进程，也只实现了上面列出的命令。

### 类型

- `config/cache.ts` 中声明了 `driver: 'redis'` 的 `redis` 存储时，`Cache.store('redis')` 返回 `RedisCacheRepository`；`memory` 存储返回 `MemoryCacheRepository`（接口相同，供测试使用）；其它驱动返回 `CacheRepository`。这些类型来自生成的配置类型（`haze dev` / `haze typegen`），生成之前所有存储都是 `CacheRepository`。
- `Cache.redis(name?)` 的返回类型总是 `RedisCacheRepository`，存储没有数据结构时在运行时报错（为了测试，memory 存储也可以）。
- `isRedisCache(repository)` 是运行时的类型守卫；`CacheRepositoryFor<'name'>` 得到某个存储名对应的类型。

```ts
import { Cache, isRedisCache } from '@hazejs/core'

const store = Cache.store() // 默认存储：CacheRepository
if (isRedisCache(store))
  await store.hash('report').set('status', 'done')
```

## 序列化

默认以 JSON 存储，并还原类型：`Date`、`BigInt`、`Map`、`Set`，以及数组和对象中的 `undefined`，读回来仍是原来的类型。只有这几种值会带一个紧凑的标记，其它值都是普通 JSON，其它语言和工具照样可以读取：

```json
{"id":1,"name":"Ada","joined":{"$t":"Date","v":"2026-10-28T08:00:00.000Z"},"roles":{"$t":"Set","v":["admin"]}}
```

- 实现了 `toJSON()` 的对象（模型、API 资源）与原来一样按 `toJSON()` 的结果存储。
- 旧版本写入的值（纯 JSON）照常读取。唯一的例外是只有 `$t` 与 `v` 两个键、且 `$t` 恰好是标记名的对象；新写入的值中如果有这样的对象，会自动转义。
- 自增计数与锁存的是原始的数字和字符串，不经过序列化器。

序列化器可以全局设置，也可以按存储设置：

```ts
export default defineCacheConfig(() => ({
  default: 'redis',
  serializer: 'typed', // 默认
  stores: {
    redis: { driver: 'redis', connection: 'default' },
    // 纯 JSON，例如给其它服务读取的数据：Date 与 BigInt 都写为字符串
    shared: { driver: 'redis', connection: 'default', serializer: 'json' },
    // 自定义：{ serialize(value): string, deserialize(raw): unknown }
    packed: { driver: 'redis', connection: 'default', serializer: msgpackSerializer },
  },
}))
```

`jsonSerializer` 与 `typedSerializer` 也已导出，可以复用。使用自定义序列化器时，`push` 退回先读后写；哈希的 `increment` 只对序列化器存为普通数字的字段有效。

::: warning 升级注意
使用 typed 序列化器后，缓存的 `Date` 读回来是 `Date`，`BigInt` 读回来是 `bigint`，以前的版本返回字符串。滚动发布期间，仍在运行旧版本的实例会把新写入的带标记的值读成 `{ $t, v }` 对象。需要保持原来的行为时设置 `serializer: 'json'`。
:::

## 底层客户端

缓存接口没有覆盖的操作，可以用 `handler()` 取驱动的客户端：

| 驱动 | `await Cache.store(name).handler()` |
| --- | --- |
| `redis` | 存储所用 `config/redis.ts` 连接的共享 ioredis 客户端（与 `Redis` 门面是同一个实例），类型为 `RedisClient` |
| `upstash` | `@upstash/redis` 客户端（`UpstashClientLike`；需要完整类型时断言为 `@upstash/redis` 的 `Redis`） |
| `memory` | 内存中的 `Map<string, MemoryCacheEntry>` |
| `kv` | KV 绑定（`KvNamespaceLike`；可断言为 `KVNamespace`） |

直接在客户端上使用的键不会自动加缓存前缀，带前缀的键用 `repository.key('name')` 取得。

## 驱动能力对比

| | memory | redis | upstash | kv |
| --- | --- | --- | --- | --- |
| 原子的 `add` / `inc` / 锁 | 是 | 是 | 是 | 否（先读后写） |
| `push` | 原子 | 原子（Lua） | 原子（Lua） | 先读后写 |
| `ttl()` | 是 | 是 | 是 | 由元数据计算；没有设置 TTL 写入的值视为永久 |
| `touch()` | 是 | 是（`EXPIRE` / `PERSIST`） | 是 | 连同值重新写入（KV 不能只改有效期） |
| 标签 | 版本号 | 版本号 + 键索引，`clear()` 时删除 | 版本号 | 版本号，最终一致 |
| 数据结构 | 模拟（供测试） | 是 | — | — |
| `handler()` | `Map` | ioredis 客户端 | Upstash 客户端 | KV 绑定 |

`custom` 存储实现了 `CacheStore` 中对应的可选成员时即可使用相应功能；没有 `touch` 时 `touch()` 会重新写入值，没有 `push` 时 `push()` 为先读后写。

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

`manager.store(name?)` 返回与门面相同的仓库对象（也接受任意字符串），`manager.redis(name?)` 与 `Cache.redis()` 相同。缓存操作（包括清除标签与数据结构命令）会显示在 [开发面板](./observability) 中，开启后也会生成 OpenTelemetry span。
