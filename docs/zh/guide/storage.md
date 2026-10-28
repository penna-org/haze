# 文件存储

hazejs 内置文件存储抽象：本地文件系统、Amazon S3（及 S3 兼容服务）、Cloudflare R2 与内存磁盘共用同一套 `Disk` 接口。业务代码只关心路径，文件实际存到哪里由磁盘配置决定。

```ts
import { Storage } from '@hazejs/core'

await Storage.put('reports/2026.csv', csv)
const url = await Storage.disk('s3').temporaryUrl('reports/2026.csv', '10m')
```

## 配置

磁盘在 `config/filesystem.ts` 中定义（全栈项目为 `server/config/filesystem.ts`）：

```ts
// config/filesystem.ts
import { defineFilesystemConfig, env } from '@hazejs/core'

export default defineFilesystemConfig(() => ({
  default: env('FILESYSTEM_DISK', 'local'),
  disks: {
    local: { driver: 'local', root: 'storage/app' },
    public: {
      driver: 'local',
      root: 'storage/app/public',
      url: '/storage',
      serve: true,
    },
    s3: {
      driver: 's3',
      bucket: env('S3_BUCKET', ''),
      region: env('S3_REGION', 'us-east-1'),
      endpoint: env('S3_ENDPOINT', '') || undefined,
      accessKeyId: env('S3_ACCESS_KEY_ID', ''),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY', ''),
      url: env('S3_URL', '') || undefined,
    },
  },
}))
```

| 选项 | 说明 |
|------|------|
| `default` | `Storage` 门面在未指定磁盘时使用的磁盘，默认 `local` |
| `disks` | 具名磁盘，与内置的 `local`、`public` 合并 |
| `signedRoute` | 没有原生预签名的磁盘生成签名临时链接时使用的路由前缀，默认 `/__haze/storage` |

即使没有 `config/filesystem.ts`，也有两个可用的本地磁盘：

- `local`：根目录 `storage/app`，私有；
- `public`：根目录 `storage/app/public`，`url: '/storage'`、`serve: true`，文件可经 `/storage/<path>` 访问。

::: tip
记得把 `storage` 加入 `.gitignore`，项目模板已经加好了。
:::

## 驱动

### local

适用于 Node、Bun、Deno。`root` 在运行时相对工作目录解析（默认 `storage/app`），读写都是流式的，路径不可能越出根目录。

```ts
{ driver: 'local', root: 'storage/app/public', url: '/storage', serve: true }
```

- `url`：公开访问的 URL 前缀，可以是站内路径（`/storage`），也可以是 CDN 地址；
- `serve`：由框架在 `url` 路径下直接提供文件（此时 `url` 必须是站内路径），默认 `false`。

### s3

基于 AWS SDK v3，支持 AWS S3 与各类 S3 兼容服务（R2 的 S3 接口、MinIO、RustFS 等）。使用前先安装 SDK：

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
```

| 选项 | 说明 |
|------|------|
| `bucket` | 桶名（必填） |
| `region` | 默认 `us-east-1` |
| `endpoint` | S3 兼容服务的地址 |
| `forcePathStyle` | 路径风格访问；设置了 `endpoint` 时默认为 `true`（多数自建服务需要） |
| `accessKeyId` / `secretAccessKey` | 访问凭证；省略时使用 AWS SDK 的默认凭证链 |
| `root` | 键前缀，该磁盘上的所有路径都会加上它 |
| `url` | 公开访问的 URL 前缀（CDN 或公共读的桶地址）；不设置时请用 `temporaryUrl()` |
| `multipartThreshold` | 超过该大小（字节）时使用分片上传，默认 8MB；内容为流时总是分片上传 |

```ts
// MinIO、RustFS 等 S3 兼容服务
minio: {
  driver: 's3',
  bucket: 'uploads',
  endpoint: 'http://127.0.0.1:9000',
  accessKeyId: env('S3_ACCESS_KEY_ID', ''),
  secretAccessKey: env('S3_SECRET_ACCESS_KEY', ''),
},
```

### r2

通过 Workers 绑定访问 Cloudflare R2。`binding` 为 `wrangler.json` 中 `r2_buckets` 的绑定名（默认 `BUCKET`），也可以直接传入 `R2Bucket` 对象。

```ts
r2: { driver: 'r2', binding: 'BUCKET', url: 'https://files.example.com' },
```

R2 绑定没有原生预签名，`temporaryUrl()` 走框架的签名路由。如果需要直连 R2 的预签名链接，请改用 `s3` 驱动连接 R2 的 S3 接口。绑定的配置方法见[部署](./deployment#cloudflare)。

### memory 与 custom

- `{ driver: 'memory', url? }`：文件保存在内存中，适合测试；
- `{ driver: 'custom', disk }`：传入自己实现的 `DiskDriver`（`put`、`get`、`stream`、`meta`、`delete`、`copy`、`list`，以及可选的 `url`、`temporaryUrl`）。

## Disk 接口

`Storage.disk(name)` 返回一个 `Disk`。`Disk` 的所有方法也可以直接在 `Storage` 上调用，作用于默认磁盘。

```ts
import { Storage } from '@hazejs/core'

const disk = Storage.disk('s3')

// 写入
await disk.put('notes/a.txt', 'hello') // string | Uint8Array | ArrayBuffer | Blob | ReadableStream
await disk.put('exports/data.json', json, { contentType: 'application/json', cacheControl: 'max-age=60' })
const path = await disk.putFile('avatars', file) // 随机文件名，保留扩展名
await disk.putFileAs('avatars', file, 'ada.png')

// 读取（文件不存在时为 undefined）
await disk.get('notes/a.txt') // Uint8Array
await disk.text('notes/a.txt') // string
await disk.json<{ id: number }>('exports/data.json')
await disk.stream('videos/intro.mp4') // ReadableStream
await disk.meta('notes/a.txt') // { path, size, contentType?, lastModified?, etag? }
await disk.exists('notes/a.txt')
await disk.missing('notes/a.txt')
await disk.size('notes/a.txt')

// 管理
await disk.copy('notes/a.txt', 'notes/b.txt')
await disk.move('notes/b.txt', 'archive/b.txt')
await disk.delete(['notes/a.txt', 'archive/b.txt']) // 返回实际删除的数量
await disk.deleteDirectory('archive')
await disk.files('notes') // 只含直接子文件
await disk.files('notes', { recursive: true })
```

`put()` 的选项有 `contentType`（默认按扩展名推断）、`cacheControl` 与 `filename`（下载时的文件名），后两项在 S3 / R2 上作为对象元数据保存。

## 文件上传

multipart 请求中的文件是 `UploadedFile`（见[请求与校验](./requests)）。`store()` 把文件保存到磁盘，文件名随机生成并保留原扩展名，返回磁盘内路径：

```ts
// app/controller/AuthController.ts
import type { HttpContext } from '@hazejs/core'
import { Storage, validate } from '@hazejs/core'
import { AvatarSchema } from '~/app/validate/auth'

export class AuthController {
  async avatar(ctx: HttpContext) {
    const { avatar } = await validate(AvatarSchema, await ctx.body())
    const path = await (await ctx.file('avatar'))!.store('avatars', 'public')
    return ctx.created({
      path,
      url: Storage.disk('public').url(path), // /storage/avatars/<uuid>.png
      size: avatar.size,
    })
  }
}
```

第二个参数可以是磁盘名，也可以是选项对象：`file.store('docs', { disk: 's3', cacheControl: 'max-age=3600' })`。需要自己指定文件名时用 `file.storeAs(dir, name, options)`。

## 访问链接

### 公开链接

`url(path)` 根据磁盘的 `url` 选项生成公开链接，磁盘没有配置 `url` 时会抛出异常：

```ts
Storage.disk('public').url('avatars/ada.png') // /storage/avatars/ada.png
```

`serve: true` 且 `url` 为站内路径的本地磁盘由框架直接提供文件，支持 `Content-Type`、`ETag`、`304` 与 `HEAD`。文件不存在或路径试图穿越时交给后续路由处理（通常就是 404）。Cloudflare Workers 上不会启用这一层，请改用配置了公共域名的 `r2` 磁盘。

### 临时链接

`temporaryUrl(path, expires, options?)` 生成会过期的链接，`expires` 为秒数或 `'10m'` 这样的时长字符串：

```ts
const link = await Storage.disk('s3').temporaryUrl('invoices/42.pdf', '10m', { download: 'invoice-42.pdf' })
```

- **s3**：返回原生预签名链接；
- **local / r2 / memory**：返回框架签名的链接 `/__haze/storage/<disk>/<path>?expires=…&signature=…`。签名是以 `APP_KEY` 计算的 HMAC，覆盖磁盘、路径、过期时间与下载文件名；被篡改或已过期的链接返回 `403`。

签名链接默认是站内路径。需要绝对地址时，在 `config/app.ts` 中设置 `url`：

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  url: env('APP_URL', '') || undefined, // https://example.com/__haze/storage/...
}))
```

## 文件响应

在控制器中用 `response()` 或 `download()` 直接返回文件：

```ts
// route/files.ts
import { defineRoutes, Storage } from '@hazejs/core'

export default defineRoutes((r) => {
  r.get('/reports/:name', ctx => Storage.response(`reports/${ctx.param('name')}`, { request: ctx.req }))
  r.get('/export', () => Storage.download('reports/2026.csv', '报表.csv'))
})
```

响应以流的方式输出文件，并带上 `Content-Type`、`Content-Length`、`ETag` 与 `Last-Modified`。传入 `request` 后支持 `If-None-Match` → `304` 与 `HEAD`。`download`（或 `response(path, { download: true | '文件名.csv' })`）会加上 `Content-Disposition: attachment`，中文文件名也能正确下载。文件不存在时抛出 `NotFoundException`（404）。

## 路径安全

所有路径在交给驱动之前都会规范化：去掉开头的 `/`，合并重复的 `/` 与 `.`，含 `..` 的路径直接报错。本地驱动还会拒绝任何解析到根目录之外的路径。`putFile` / `putFileAs` / `storeAs` 只取文件名的最后一段，客户端传来的文件名无法借此穿越目录。

## 测试

`Storage.fake(name?)` 把磁盘替换为内存磁盘（保留配置中的 `url`），并返回带断言的 `FakeDisk`：

```ts
// tests/avatar.test.ts
import { Storage } from '@hazejs/core'
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'
import { User } from '~/app/model/User'

const t = useTestApp()

it('uploads an avatar to the public disk', async () => {
  const disk = Storage.fake('public')
  const user = await User.create({ name: 'Bob', email: 'bob@example.com' })
  const form = new FormData()
  form.set('avatar', new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' }))

  const res = await (await t.actingAs(user)).post('/api/auth/avatar', form)
  expect(res.body.data.url).toBe(`/storage/${res.body.data.path}`)
  await disk.assertExists(res.body.data.path)
})
```

| 断言 | 检查内容 |
|------|----------|
| `assertExists(path \| paths)` | 文件存在 |
| `assertMissing(path \| paths)` | 文件不存在 |
| `assertCount(dir, n)` | `dir` 下（递归）共有 `n` 个文件 |
| `assertDirectoryEmpty(dir)` | `dir` 下没有文件 |

`Storage.restore(name?)` 恢复为配置中的磁盘。使用 `useTestApp()` 时每个用例都是全新的应用，fake 不会泄漏到其它用例。详见[测试](./testing)。
