import type { Application } from '../application'
import type { HttpContext } from '../http/context'
import type { TranslationKey, TranslationParams } from '../i18n/manager'
import type { RawHtml } from '../mail/layout'
import type { Component, ViewChild, ViewNode } from './jsx'
import { useI18n } from '../i18n/manager'
import { escapeHtml, rawHtml } from '../mail/layout'
import { getRequestStore } from '../request'
import { isViewNode, jsx, renderChild } from './jsx'

export interface ViewResponseInit {
  /** 状态码，默认取 ctx.status() 设置的值，否则 200 */
  status?: number
  headers?: ConstructorParameters<typeof Headers>[0]
}

/** 视图名（app/view 下相对路径、不含扩展名，如 `Home`、`admin/Dashboard`）或组件、JSX 节点 */
export type ViewInput = ViewNode | Component<any> | string

const VIEW_PATH_RE = /\/app\/view\/(.+)\.[cm]?[jt]sx?$/

/** 视图名 → 模块加载函数（键为 app/view 下的相对路径，不含扩展名） */
export function viewLoaders(app: Application): Map<string, () => Promise<unknown>> {
  const loaders = new Map<string, () => Promise<unknown>>()
  for (const [path, entry] of Object.entries(app.viewModules())) {
    const name = VIEW_PATH_RE.exec(path)?.[1]
    if (!name)
      continue
    loaders.set(name, typeof entry === 'function'
      ? entry as () => Promise<unknown>
      : () => Promise.resolve(entry))
  }
  return loaders
}

/** 是否存在该名称的视图（app/view/<name>.tsx） */
export function hasView(app: Application, name: string): boolean {
  return viewLoaders(app).has(name.replace(/^\/+|\.[cm]?[jt]sx?$/g, ''))
}

/** 按名称加载 app/view 下的组件（默认导出，或与文件同名的具名导出） */
export async function resolveView(app: Application, name: string): Promise<Component<any>> {
  const key = name.replace(/^\/+|\.[cm]?[jt]sx?$/g, '')
  const load = viewLoaders(app).get(key)
  if (!load)
    throw new Error(`View "${key}" not found (expected app/view/${key}.tsx)`)
  const mod = await load() as Record<string, unknown>
  const component = mod.default ?? mod[key.split('/').pop()!]
  if (typeof component !== 'function')
    throw new TypeError(`app/view/${key}.tsx must export a component (default export)`)
  return component as Component<any>
}

/** 把视图输入（节点 / 组件 / 视图名）转为节点 */
export async function toViewNode(input: ViewInput, props: Record<string, unknown> = {}, app?: Application): Promise<ViewNode> {
  if (isViewNode(input))
    return input
  const component = typeof input === 'string'
    ? await resolveView(app ?? currentApp(), input)
    : input
  return jsx(component, props)
}

function currentApp(): Application {
  const app = getRequestStore()?.app
  if (!app)
    throw new Error('Rendering a view by name needs an application (call it within a request)')
  return app
}

/**
 * 渲染为 HTML 响应（`text/html`，不经过统一响应格式）。以 `<html` 开头的页面自动补上 `<!DOCTYPE html>`。
 */
export async function renderViewResponse(node: ViewChild, ctx: HttpContext | undefined, init: ViewResponseInit = {}): Promise<Response> {
  let html = await renderChild(node)
  if (/^\s*<html[\s>]/i.test(html))
    html = `<!DOCTYPE html>${html}`
  const headers = new Headers(init.headers)
  if (!headers.has('content-type'))
    headers.set('content-type', 'text/html; charset=utf-8')
  return new Response(html, {
    status: init.status ?? ctx?.event.res.status ?? 200,
    headers,
  })
}

/** ctx.view() 的实现：`ctx.view(<Home />)`、`ctx.view(Home, props)`、`ctx.view('Home', props)` */
export async function contextView(ctx: HttpContext, input: ViewInput, propsOrInit?: Record<string, unknown> | ViewResponseInit, init?: ViewResponseInit): Promise<Response> {
  const node = isViewNode(input)
    ? input
    : await toViewNode(input, propsOrInit as Record<string, unknown> | undefined, getRequestStore()?.app)
  const options = isViewNode(input)
    ? propsOrInit as ViewResponseInit | undefined
    : init
  return renderViewResponse(node, ctx, options)
}

function requestContext(caller: string): HttpContext {
  const ctx = getRequestStore()?.ctx
  if (!ctx)
    throw new Error(`${caller}() can only be called within a request`)
  return ctx
}

/**
 * 在请求中渲染视图并返回 HTML 响应（等同于 `ctx.view()`）：
 *
 * ```tsx
 * r.get('/', () => view(<Home user={user} />))
 * r.get('/about', () => view('About', { title: 'About' }, { headers: { 'cache-control': 'max-age=60' } }))
 * ```
 */
export function view(node: ViewNode, init?: ViewResponseInit): Promise<Response>
export function view<P>(component: Component<P> | string, props?: P, init?: ViewResponseInit): Promise<Response>
export function view(input: ViewInput, propsOrInit?: Record<string, unknown> | ViewResponseInit, init?: ViewResponseInit): Promise<Response> {
  return contextView(requestContext('view'), input, propsOrInit, init)
}

/** 组件中读取当前请求的 HttpContext */
export function useHttpContext(): HttpContext {
  return requestContext('useHttpContext')
}

export interface ViewHelpers {
  ctx: HttpContext
  /** 当前请求的语言 */
  locale: string
  /** 按当前请求的语言翻译 */
  t: <K extends TranslationKey>(key: K, params?: TranslationParams) => string
  /** 上一次提交的输入（见 old()） */
  old: (field: string, fallback?: string) => string | undefined
  /** 当前会话的 CSRF token */
  csrfToken: () => Promise<string>
}

/** 组件中使用的请求相关工具：`const { ctx, t, old } = useView()` */
export function useView(): ViewHelpers {
  const ctx = requestContext('useView')
  return {
    ctx,
    locale: ctx.locale,
    t: (key, params) => useI18n().translate(key, params, ctx.locale),
    old: (field, fallback) => old(field, fallback),
    csrfToken: () => ctx.csrfToken(),
  }
}

/**
 * 表单中的 CSRF 隐藏字段 `<input type="hidden" name="_token" value="...">`（`csrf` 中间件校验）：
 *
 * ```tsx
 * <form method="post" action="/posts">{csrfField()}...</form>
 * ```
 */
export async function csrfField(): Promise<RawHtml> {
  const token = await requestContext('csrfField').csrfToken()
  return rawHtml(`<input type="hidden" name="_token" value="${escapeHtml(token)}">`)
}

/** 会话中闪存旧输入的键 */
export const OLD_INPUT_KEY = '_old_input'

/** 不闪存的字段（密码等） */
const SENSITIVE_INPUT = new Set([
  '_token',
  'password',
  'password_confirmation',
  'current_password',
])

/**
 * 把本次提交的输入闪存到会话（下一次请求中可用 old() 读取），常在校验失败后重定向回表单前调用。
 * 默认取请求体，跳过 `_token` 与密码字段；需要 `session` 中间件或 APP_KEY。
 */
export async function flashInput(input?: Record<string, unknown>, ctx: HttpContext = requestContext('flashInput')): Promise<void> {
  const data = input ?? await ctx.body<Record<string, unknown> | undefined>() ?? {}
  const session = await ctx.startSession()
  session.flash(OLD_INPUT_KEY, Object.fromEntries(Object.entries(data).filter(([key, value]) =>
    !SENSITIVE_INPUT.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value)))))
}

/**
 * 上一次提交的输入（flashInput() 闪存到会话），用于表单回填：`<input name="email" value={old('email')} />`。
 * 会话未启动（没有 `session` 中间件）或没有旧输入时返回 fallback。
 */
export function old(field: string, fallback?: string): string | undefined {
  const ctx = getRequestStore()?.ctx
  if (!ctx)
    return fallback
  let input: Record<string, unknown> | undefined
  try {
    input = ctx.session.get<Record<string, unknown>>(OLD_INPUT_KEY)
  }
  catch {
    return fallback
  }
  const value = input?.[field]
  if (value === undefined || value === null)
    return fallback
  return Array.isArray(value)
    ? value.map(String).join(',')
    : String(value)
}
