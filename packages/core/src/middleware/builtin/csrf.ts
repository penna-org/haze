import type { HttpContext } from '../../http/context'
import type { Session } from '../../session/session'
import type { MiddlewareHandler } from '../types'
import { CsrfTokenMismatchException } from '../../exception/exceptions'
import { mutableResponse, serializeCookie } from '../../http/cookie'
import { safeEqual, toBase64Url } from '../../security/key'

export interface CsrfConfig {
  /** 不校验的路径，支持 `*` 通配：`['/api/webhooks/*']` */
  except?: string[]
  /** 供前端读取的 token Cookie（axios 等会自动回传到 X-XSRF-TOKEN），默认 `XSRF-TOKEN`，false 不下发 */
  cookie?: string | false
  /** 测试环境（mode 为 test）也校验，默认 false（与 Laravel 一致） */
  testing?: boolean
}

export function defineCsrfConfig(config: CsrfConfig | (() => CsrfConfig)): CsrfConfig | (() => CsrfConfig) {
  return config
}

const SESSION_KEY = '_csrf'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

function newToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/** 当前会话的 CSRF token（没有时生成）；服务端渲染表单时放入隐藏字段 `_token` */
export async function csrfToken(ctx: HttpContext): Promise<string> {
  const session = await ctx.startSession()
  let token = session.get<string>(SESSION_KEY)
  if (!token) {
    token = newToken()
    session.set(SESSION_KEY, token)
  }
  return token
}

/** 更换 token（登录 / 退出时由 Session Guard 调用，防止 token 固定） */
export function regenerateCsrfToken(session: Session): void {
  session.set(SESSION_KEY, newToken())
}

function matches(path: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return regex.test(path)
}

async function providedToken(ctx: HttpContext): Promise<string | undefined> {
  const header = ctx.header('x-csrf-token') ?? ctx.header('x-xsrf-token')
  if (header)
    return header
  // 普通表单提交：隐藏字段 _token
  const type = (ctx.header('content-type') ?? '').toLowerCase()
  if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
    const body = await ctx.body<Record<string, unknown> | undefined>()
    return typeof body?._token === 'string'
      ? body._token
      : undefined
  }
  return undefined
}

/**
 * `csrf`：同步令牌（Laravel 方式）。token 存在会话中，并通过 `XSRF-TOKEN` Cookie 下发给前端；
 * 不安全的方法（POST / PUT / PATCH / DELETE）须在 `X-CSRF-TOKEN` / `X-XSRF-TOKEN` 头或表单 `_token` 字段中回传，
 * 否则返回 419。带 `Authorization: Bearer` 的请求不依赖 Cookie 认证，不校验。
 */
export const csrf: MiddlewareHandler = async (ctx, next) => {
  const config = ctx.config.get<CsrfConfig>('csrf', {})
  const cookieName = config.cookie ?? 'XSRF-TOKEN'
  const session = await ctx.startSession()
  const token = await csrfToken(ctx)

  // 响应前同步 Cookie（登录 / 退出后 token 会更换）
  ctx.onResponse((response) => {
    let current = session.get<string>(SESSION_KEY)
    if (!current) {
      current = newToken()
      session.set(SESSION_KEY, current)
    }
    if (!cookieName || ctx.cookie(cookieName) === current)
      return
    const next = mutableResponse(response)
    // 前端脚本需要读取，因此不设置 HttpOnly
    next.headers.append('set-cookie', serializeCookie(cookieName, current, {
      ...ctx.cookieDefaults(),
      httpOnly: false,
    }))
    return next
  })

  if (SAFE_METHODS.has(ctx.method)
    || /^Bearer\s/i.test(ctx.header('authorization') ?? '')
    || (ctx.config.get<string>('app.mode', 'production') === 'test' && !config.testing)
    || config.except?.some(pattern => matches(ctx.path, pattern))) {
    return next()
  }
  const provided = await providedToken(ctx)
  if (!provided || !safeEqual(provided, token))
    throw new CsrfTokenMismatchException('CSRF token 无效或已过期，请刷新页面后重试')
  return next()
}
