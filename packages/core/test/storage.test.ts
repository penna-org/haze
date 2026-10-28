import type { Application, DiskConfig, RouteRegistrar } from '../src'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApplication, defineRoutes, disposePersistent, generateKey, NotFoundException, setPlatformBindings, Storage, StorageManager } from '../src'

/** R2：在 workerd 中运行（Miniflare），Node 侧通过绑定代理访问 */
let miniflare: Miniflare | undefined
const dir = mkdtempSync(join(tmpdir(), 'hazejs-storage-'))

// 真实 S3 兼容服务（本地可用 RustFS / MinIO）：HAZE_TEST_S3_ENDPOINT=http://127.0.0.1:19000
const s3 = process.env.HAZE_TEST_S3_ENDPOINT
  ? {
      endpoint: process.env.HAZE_TEST_S3_ENDPOINT,
      bucket: process.env.HAZE_TEST_S3_BUCKET ?? 'hazejs-test',
      accessKeyId: process.env.HAZE_TEST_S3_ACCESS_KEY ?? 'rustfsadmin',
      secretAccessKey: process.env.HAZE_TEST_S3_SECRET_KEY ?? 'rustfsadmin',
    }
  : undefined

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch: () => new Response() }',
    r2Buckets: ['BUCKET'],
  })
  setPlatformBindings({ BUCKET: await miniflare.getR2Bucket('BUCKET') })
  if (s3) {
    const { CreateBucketCommand, S3Client } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: s3.endpoint,
      forcePathStyle: true,
      credentials: s3,
    })
    await client.send(new CreateBucketCommand({ Bucket: s3.bucket })).catch((error: { name?: string }) => {
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name ?? ''))
        throw error
    })
    client.destroy()
  }
})

afterAll(async () => {
  await disposePersistent()
  await miniflare?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

interface Driver {
  name: string
  config: DiskConfig
  /** 原生预签名链接（直接访问存储服务，不经过应用） */
  presigned?: boolean
}

const drivers: Driver[] = [
  {
    name: 'memory',
    config: { driver: 'memory' },
  },
  {
    name: 'local',
    config: {
      driver: 'local',
      root: join(dir, 'local'),
    },
  },
  {
    name: 'r2',
    config: { driver: 'r2', binding: 'BUCKET' },
  },
  ...(s3
    ? [
        {
          name: 's3',
          config: {
            driver: 's3',
            region: 'us-east-1',
            root: `run-${crypto.randomUUID()}`,
            ...s3,
          } as DiskConfig,
          presigned: true,
        },
      ]
    : []),
]

function boot(disks: Record<string, DiskConfig>, routes: RouteRegistrar = () => {}, config: Record<string, unknown> = {}) {
  return createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: {
        key: generateKey(),
      },
      filesystem: { default: Object.keys(disks)[0], disks },
      ...config,
    },
    routes: [
      defineRoutes(routes),
    ],
  })
}

const bytes = (text: string) => new TextEncoder().encode(text)

describe.each(drivers)('storage: $name', (driver) => {
  let app: Application
  beforeAll(async () => {
    app = await boot({ main: driver.config })
  })
  afterAll(() => app.dispose())
  const disk = () => app.make(StorageManager).disk('main')

  it('writes and reads strings, bytes, blobs and JSON', async () => {
    expect(await disk().put('/docs//hello.txt', 'hello')).toBe('docs/hello.txt')
    expect(await disk().text('docs/hello.txt')).toBe('hello')
    await disk().put('docs/data.json', JSON.stringify({ ok: true }))
    expect(await disk().json('docs/data.json')).toEqual({ ok: true })
    await disk().put('docs/raw.bin', new Uint8Array([1, 2, 3]))
    expect([
      ...(await disk().get('docs/raw.bin'))!,
    ]).toEqual([1, 2, 3])
    await disk().put('docs/blob.txt', new Blob(['from blob']))
    expect(await disk().text('docs/blob.txt')).toBe('from blob')

    expect(await disk().exists('docs/hello.txt')).toBe(true)
    expect(await disk().missing('docs/nope.txt')).toBe(true)
    expect(await disk().get('docs/nope.txt')).toBeUndefined()
    expect(await disk().size('docs/hello.txt')).toBe(5)
    const meta = (await disk().meta('docs/data.json'))!
    expect(meta.contentType).toContain('application/json')
    expect(meta.lastModified).toBeInstanceOf(Date)
  })

  it('streams uploads and downloads', async () => {
    const chunks = [
      'a'.repeat(1000),
      'b'.repeat(1000),
      'c'.repeat(1000),
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(bytes(chunk))
        controller.close()
      },
    })
    await disk().put('streams/big.txt', body)
    const stream = (await disk().stream('streams/big.txt'))!
    expect(await new Response(stream).text()).toBe(chunks.join(''))
    expect(await disk().stream('streams/none.txt')).toBeUndefined()
  })

  it('copies, moves, lists and deletes', async () => {
    await disk().put('tree/a.txt', 'a')
    await disk().put('tree/sub/b.txt', 'b')
    await disk().copy('tree/a.txt', 'tree/copy.txt')
    await disk().move('tree/copy.txt', 'tree/sub/moved.txt')
    expect(await disk().files('tree')).toEqual(['tree/a.txt'])
    expect(await disk().files('tree', { recursive: true })).toEqual(['tree/a.txt', 'tree/sub/b.txt', 'tree/sub/moved.txt'])
    await expect(disk().copy('tree/none.txt', 'tree/x.txt')).rejects.toThrow('File not found')

    expect(await disk().delete(['tree/a.txt', 'tree/none.txt'])).toBe(1)
    expect(await disk().deleteDirectory('tree')).toBe(2)
    expect(await disk().files('tree', { recursive: true })).toEqual([])
  })

  it('rejects path traversal', async () => {
    await expect(disk().put('../escape.txt', 'x')).rejects.toThrow('Invalid storage path')
    await expect(disk().get('a/../../b')).rejects.toThrow('Invalid storage path')
  })

  it('builds file responses with content type, ETag and downloads', async () => {
    await disk().put('files/report.csv', 'a,b\n1,2\n')
    const response = await disk().response('files/report.csv')
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(response.headers.get('content-length')).toBe('8')
    expect(await response.text()).toBe('a,b\n1,2\n')
    const etag = response.headers.get('etag')!
    expect(etag).toBeTruthy()
    const cached = await disk().response('files/report.csv', {
      request: new Request('http://x', {
        headers: { 'if-none-match': etag },
      }),
    })
    expect(cached.status).toBe(304)

    const download = await disk().download('files/report.csv', '报表.csv')
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="__.csv"; filename*=UTF-8''${encodeURIComponent('报表.csv')}`)
    await expect(disk().response('files/none.csv')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('issues temporary URLs that expire', async () => {
    await disk().put('private/secret.txt', 'top secret')
    const url = await disk().temporaryUrl('private/secret.txt', '5m', { download: 'secret.txt' })
    const res = driver.presigned
      ? await fetch(url)
      : await app.request(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('top secret')
    expect(res.headers.get('content-disposition')).toContain('secret.txt')
    if (driver.presigned)
      return

    // 篡改路径或过期后失效
    expect((await app.request(url.replace('secret.txt?', 'other.txt?'))).status).toBe(403)
    const expired = await disk().temporaryUrl('private/secret.txt', 0)
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect((await app.request(expired)).status).toBe(403)
  })

  it.runIf(driver.name === 's3')('uploads large streams as multipart', async () => {
    const size = 6 * 1024 * 1024
    const chunk = new Uint8Array(1024 * 1024).fill(7)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size)
          return controller.close()
        controller.enqueue(chunk)
        sent += chunk.byteLength
      },
    })
    await disk().put('multipart/big.bin', body)
    expect(await disk().size('multipart/big.bin')).toBe(size)
    await disk().delete('multipart/big.bin')
  })
})

describe('storage over HTTP', () => {
  const root = join(dir, 'http')
  const app = boot({
    local: {
      driver: 'local',
      root: join(root, 'private'),
    },
    public: {
      driver: 'local',
      root: join(root, 'public'),
      url: '/storage',
      serve: true,
    },
  }, (r) => {
    r.post('/avatar', async (ctx) => {
      const file = (await ctx.file('avatar'))!
      const path = await file.store('avatars', 'public')
      return {
        path,
        url: Storage.disk('public').url(path),
      }
    })
    r.get('/files/:name', ctx => Storage.response(`docs/${ctx.param('name')}`, { request: ctx.req }))
  }, {
    app: {
      url: 'https://example.test',
      key: generateKey(),
    },
  })

  it('stores uploads on a disk and serves public disks at their url', async () => {
    const form = new FormData()
    form.set('avatar', new File(['png bytes'], 'Me.PNG', { type: 'image/png' }))
    const res = await (await app).request('/avatar', { method: 'POST', body: form })
    const { data } = await res.json() as any
    expect(data.path).toMatch(/^avatars\/[\w-]+\.png$/)
    expect(data.url).toBe(`/storage/${data.path}`)

    const served = await (await app).request(data.url)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(await served.text()).toBe('png bytes')
    // 不存在的文件与穿越路径交给后续路由（404）
    expect((await (await app).request('/storage/avatars/none.png')).status).toBe(404)
    expect((await (await app).request('/storage/..%2Fprivate%2Fx.txt')).status).toBe(404)
  })

  it('returns file responses from handlers and absolute signed URLs from APP_URL', async () => {
    const storage = (await app).make(StorageManager)
    await storage.disk().put('docs/readme.md', '# hi')
    const res = await (await app).request('/files/readme.md')
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await res.text()).toBe('# hi')
    expect((await (await app).request('/files/none.md')).status).toBe(404)

    const url = await storage.disk().temporaryUrl('docs/readme.md', 60)
    expect(url).toMatch(/^https:\/\/example\.test\/__haze\/storage\/local\/docs\/readme\.md\?expires=\d+&signature=/)
    expect(await (await (await app).request(url)).text()).toBe('# hi')
    expect(() => storage.disk().url('docs/readme.md')).toThrow('has no public url')
  })

  it('fakes disks in tests', async () => {
    const fake = (await app).make(StorageManager).fake('public')
    const form = new FormData()
    form.set('avatar', new File(['x'], 'a.jpg', { type: 'image/jpeg' }))
    const { data } = await (await (await app).request('/avatar', { method: 'POST', body: form })).json() as any
    await fake.assertExists(data.path)
    await fake.assertMissing('avatars/other.jpg')
    await fake.assertCount('avatars', 1)
    await expect(fake.assertMissing(data.path)).rejects.toThrow('not to exist')
    // fake 保留配置的 url
    expect(data.url).toBe(`/storage/${data.path}`)
    ;(await app).make(StorageManager).restore('public')
  })
})
