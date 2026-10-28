# File Storage

hazejs ships with a filesystem abstraction: one `Disk` API in front of the local filesystem, Amazon S3 (and S3-compatible services), Cloudflare R2 and in-memory disks. Your code reads and writes paths; the disk configuration decides where the bytes end up.

```ts
import { Storage } from '@hazejs/core'

await Storage.put('reports/2026.csv', csv)
const url = await Storage.disk('s3').temporaryUrl('reports/2026.csv', '10m')
```

## Configuration

Disks are defined in `config/filesystem.ts` (in full-stack projects, `server/config/filesystem.ts`):

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

| Option | Description |
|--------|-------------|
| `default` | Disk used by the `Storage` facade when no disk is named. Defaults to `local`. |
| `disks` | Named disks. Merged over the built-in `local` and `public` disks. |
| `signedRoute` | Route prefix for signed temporary URLs on disks without native presigning. Defaults to `/__haze/storage`. |

Without a `config/filesystem.ts` you still get two local disks:

- `local` — root `storage/app`, private.
- `public` — root `storage/app/public`, `url: '/storage'`, `serve: true`, so files are reachable at `/storage/<path>`.

::: tip
Add `storage` to `.gitignore` — the project templates already do.
:::

## Drivers

### local

Node, Bun and Deno. `root` is resolved against the working directory at runtime (default `storage/app`). Reads and writes are streamed, and paths can never leave the root.

```ts
{ driver: 'local', root: 'storage/app/public', url: '/storage', serve: true }
```

- `url` — public URL prefix, either a site path (`/storage`) or a CDN origin.
- `serve` — let the framework serve the disk's files under `url` (which must be a site path). Default `false`.

### s3

AWS S3 and S3-compatible services (Cloudflare R2's S3 API, MinIO, RustFS, …), built on AWS SDK v3. Install the SDK packages first:

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
```

| Option | Description |
|--------|-------------|
| `bucket` | Bucket name (required). |
| `region` | Defaults to `us-east-1`. |
| `endpoint` | Endpoint of an S3-compatible service. |
| `forcePathStyle` | Path-style addressing. Defaults to `true` when `endpoint` is set (most self-hosted services need it). |
| `accessKeyId` / `secretAccessKey` | Credentials. When omitted, the SDK's default credential chain is used. |
| `root` | Key prefix for every path on this disk. |
| `url` | Public URL prefix (CDN or public-read bucket). Without it, use `temporaryUrl()`. |
| `multipartThreshold` | Size in bytes above which uploads use multipart. Defaults to 8 MB. Streams always use multipart. |

```ts
// An S3-compatible service such as MinIO or RustFS
minio: {
  driver: 's3',
  bucket: 'uploads',
  endpoint: 'http://127.0.0.1:9000',
  accessKeyId: env('S3_ACCESS_KEY_ID', ''),
  secretAccessKey: env('S3_SECRET_ACCESS_KEY', ''),
},
```

### r2

Cloudflare R2 through a Workers binding. `binding` is the binding name from `r2_buckets` in `wrangler.json` (default `BUCKET`), or an `R2Bucket` object.

```ts
r2: { driver: 'r2', binding: 'BUCKET', url: 'https://files.example.com' },
```

R2 bindings have no native presigning, so `temporaryUrl()` goes through the framework's signed route. If you need direct presigned links to R2, use the `s3` driver against R2's S3 API instead. See [Deployment](./deployment#cloudflare) for wiring up bindings.

### memory and custom

- `{ driver: 'memory', url? }` keeps files in memory — useful for tests.
- `{ driver: 'custom', disk }` takes your own `DiskDriver` implementation (`put`, `get`, `stream`, `meta`, `delete`, `copy`, `list`, plus optional `url` and `temporaryUrl`).

## The Disk API

`Storage.disk(name)` returns a `Disk`. Every `Disk` method is also available directly on `Storage`, acting on the default disk.

```ts
import { Storage } from '@hazejs/core'

const disk = Storage.disk('s3')

// Writing
await disk.put('notes/a.txt', 'hello') // string | Uint8Array | ArrayBuffer | Blob | ReadableStream
await disk.put('exports/data.json', json, { contentType: 'application/json', cacheControl: 'max-age=60' })
const path = await disk.putFile('avatars', file) // random name, keeps the extension
await disk.putFileAs('avatars', file, 'ada.png')

// Reading (undefined when the file does not exist)
await disk.get('notes/a.txt') // Uint8Array
await disk.text('notes/a.txt') // string
await disk.json<{ id: number }>('exports/data.json')
await disk.stream('videos/intro.mp4') // ReadableStream
await disk.meta('notes/a.txt') // { path, size, contentType?, lastModified?, etag? }
await disk.exists('notes/a.txt')
await disk.missing('notes/a.txt')
await disk.size('notes/a.txt')

// Managing
await disk.copy('notes/a.txt', 'notes/b.txt')
await disk.move('notes/b.txt', 'archive/b.txt')
await disk.delete(['notes/a.txt', 'archive/b.txt']) // returns how many existed
await disk.deleteDirectory('archive')
await disk.files('notes') // direct children only
await disk.files('notes', { recursive: true })
```

`put()` options are `contentType` (inferred from the extension by default), `cacheControl` and `filename` (download name); the last two are stored as object metadata on S3 / R2.

## File uploads

Uploaded files from a multipart request are `UploadedFile` instances (see [Requests & Validation](./requests)). `store()` saves the file to a disk under a random name with its original extension and returns the path on the disk:

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

The second argument is a disk name or an options object: `file.store('docs', { disk: 's3', cacheControl: 'max-age=3600' })`. Use `file.storeAs(dir, name, options)` to choose the file name yourself.

## URLs

### Public URLs

`url(path)` builds a public link from the disk's `url` option. It throws if the disk has no `url`:

```ts
Storage.disk('public').url('avatars/ada.png') // /storage/avatars/ada.png
```

Local disks with `serve: true` and a site-path `url` are served by the framework itself, with `Content-Type`, `ETag`, `304` and `HEAD` support. Missing files and path traversal attempts fall through to your routes (usually a 404). This middleware is skipped on Cloudflare Workers, where you would use an `r2` disk with a public domain instead.

### Temporary URLs

`temporaryUrl(path, expires, options?)` returns a link that expires. `expires` is seconds or a duration string such as `'10m'`:

```ts
const link = await Storage.disk('s3').temporaryUrl('invoices/42.pdf', '10m', { download: 'invoice-42.pdf' })
```

- **s3** returns a native presigned URL.
- **local / r2 / memory** return a framework-signed URL: `/__haze/storage/<disk>/<path>?expires=…&signature=…`. The signature is an HMAC with `APP_KEY` over the disk, path, expiry and download name. Tampered or expired links get a `403`.

Signed URLs are site paths by default. To get absolute URLs, set `url` in `config/app.ts`:

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  url: env('APP_URL', '') || undefined, // https://example.com/__haze/storage/...
}))
```

## File responses

Return a file straight from a controller with `response()` or `download()`:

```ts
// route/files.ts
import { defineRoutes, Storage } from '@hazejs/core'

export default defineRoutes((r) => {
  r.get('/reports/:name', ctx => Storage.response(`reports/${ctx.param('name')}`, { request: ctx.req }))
  r.get('/export', () => Storage.download('reports/2026.csv', 'report.csv'))
})
```

Responses stream the file with `Content-Type`, `Content-Length`, `ETag` and `Last-Modified`. Passing `request` enables `If-None-Match` → `304` and `HEAD`. `download` (or `response(path, { download: true | 'name.csv' })`) adds `Content-Disposition: attachment`. A missing file throws a `NotFoundException` (404).

## Path safety

Every path is normalized before it reaches a driver: leading `/` is removed, duplicate and `.` segments are collapsed, and any `..` segment is rejected with an error. The local driver additionally refuses any path that resolves outside its root. `putFile` / `putFileAs` / `storeAs` only use the last segment of a file name, so a client-supplied name cannot traverse directories.

## Testing

`Storage.fake(name?)` swaps a disk for an in-memory disk (keeping its configured `url`) and returns a `FakeDisk` with assertions:

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

| Assertion | Checks |
|-----------|--------|
| `assertExists(path \| paths)` | The file(s) exist. |
| `assertMissing(path \| paths)` | The file(s) do not exist. |
| `assertCount(dir, n)` | `dir` contains `n` files (recursively). |
| `assertDirectoryEmpty(dir)` | `dir` contains no files. |

`Storage.restore(name?)` puts the configured disk back. With `useTestApp()` every test gets a fresh application, so fakes do not leak between tests. See [Testing](./testing).
