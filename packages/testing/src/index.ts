import type { Application, ApplicationOptions, Container, InjectionKey } from '@hazejs/core'
import { issueTestCredentials } from '@hazejs/core'
import { createApp } from 'virtual:haze/app'
import { afterEach, beforeEach } from 'vitest'

export interface TestAppOptions extends ApplicationOptions {
  /** 替换绑定（在提供者 register 之后、boot 之前执行），例如 `c => c.instance(Repo, fakeRepo)` */
  override?: (container: Container, app: Application) => void | Promise<void>
}

export interface TestRequestInit extends Omit<RequestInit, 'body'> {
  query?: Record<string, string | number | boolean>
}

export interface TestResponse<T = any> {
  status: number
  ok: boolean
  headers: Headers
  /** 按 content-type 解析：JSON 为对象，其余为文本 */
  body: T
  text: string
}

export interface TestClient {
  get: <T = any>(path: string, init?: TestRequestInit) => Promise<TestResponse<T>>
  delete: <T = any>(path: string, init?: TestRequestInit) => Promise<TestResponse<T>>
  post: <T = any>(path: string, body?: unknown, init?: TestRequestInit) => Promise<TestResponse<T>>
  put: <T = any>(path: string, body?: unknown, init?: TestRequestInit) => Promise<TestResponse<T>>
  patch: <T = any>(path: string, body?: unknown, init?: TestRequestInit) => Promise<TestResponse<T>>
  /** 返回带默认请求头的新客户端，例如 `withHeaders({ authorization: 'Bearer x' })` */
  withHeaders: (headers: Record<string, string>) => TestClient
  /**
   * 以指定用户登录的客户端：JWT Guard 签发真实令牌（Authorization 头），
   * Session Guard 生成真实的会话 Cookie。默认使用 config/auth.ts 的默认 Guard。
   */
  actingAs: (user: unknown, guard?: string) => Promise<TestClient>
}

export interface TestApp extends TestClient {
  readonly app: Application
  /** 原始 fetch 风格请求 */
  request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  make: <T>(key: InjectionKey<T>) => T
  close: () => Promise<void>
}

/**
 * 创建测试用应用（不监听端口）。使用 `virtual:haze/app`，与 dev / build 发现同一套
 * config / route / provider；默认 mode 为 `test`，会加载 `.env.test`。
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const { override, setup, ...rest } = options
  const app = await createApp({
    mode: 'test',
    ...rest,
    async setup(app) {
      await setup?.(app)
      await override?.(app.container, app)
    },
  })

  return {
    app,
    request: (input, init) => app.request(input, init),
    make: key => app.make(key),
    close: () => app.dispose(),
    ...createClient(app, {}),
  }
}

/**
 * 每个用例前创建全新的应用、用例后释放，返回的对象在用例内直接使用：
 *
 * ```ts
 * const t = useTestApp({ override: c => c.instance(UserRepository, new FakeRepo()) })
 * it('lists users', async () => {
 *   expect((await t.get('/api/users')).status).toBe(200)
 * })
 * ```
 */
export function useTestApp(options: TestAppOptions = {}): TestApp {
  let current: TestApp | undefined
  beforeEach(async () => {
    current = await createTestApp(options)
  })
  afterEach(async () => {
    await current?.close()
    current = undefined
  })

  const active = (): TestApp => {
    if (!current)
      throw new Error('useTestApp(): the app is only available inside tests (it/test or hooks after beforeEach)')
    return current
  }
  return {
    get app() {
      return active().app
    },
    request: (input, init) => active().request(input, init),
    make: key => active().make(key),
    close: () => active().close(),
    get: (path, init) => active().get(path, init),
    delete: (path, init) => active().delete(path, init),
    post: (path, body, init) => active().post(path, body, init),
    put: (path, body, init) => active().put(path, body, init),
    patch: (path, body, init) => active().patch(path, body, init),
    withHeaders: headers => active().withHeaders(headers),
    actingAs: (user, guard) => active().actingAs(user, guard),
  }
}

function createClient(app: Application, defaults: Record<string, string>): TestClient {
  const send = async (method: string, path: string, body: unknown, init: TestRequestInit = {}): Promise<TestResponse> => {
    const { query, headers, ...rest } = init
    const url = query
      ? `${path}${path.includes('?')
        ? '&'
        : '?'}${new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [
        k,
        String(v),
      ]))}`
      : path
    const merged = new Headers({ ...defaults })
    new Headers(headers).forEach((value, key) => merged.set(key, value))

    let payload: RequestInit['body']
    if (body !== undefined) {
      const raw = typeof body === 'string' || body instanceof FormData || body instanceof URLSearchParams || body instanceof Blob
      payload = raw
        ? body as RequestInit['body']
        : JSON.stringify(body)
      if (!raw && !merged.has('content-type'))
        merged.set('content-type', 'application/json')
    }

    const res = await app.request(url, {
      ...rest,
      method,
      headers: merged,
      body: payload,
    })
    const text = await res.text()
    const isJson = res.headers.get('content-type')?.includes('json') && text
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      body: isJson
        ? JSON.parse(text)
        : text,
      text,
    }
  }

  return {
    get: (path, init) => send('GET', path, undefined, init),
    delete: (path, init) => send('DELETE', path, undefined, init),
    post: (path, body, init) => send('POST', path, body, init),
    put: (path, body, init) => send('PUT', path, body, init),
    patch: (path, body, init) => send('PATCH', path, body, init),
    withHeaders: headers => createClient(app, {
      ...defaults,
      ...headers,
    }),
    actingAs: async (user, guard) => createClient(app, {
      ...defaults,
      ...await issueTestCredentials(app, user, guard),
    }),
  }
}
