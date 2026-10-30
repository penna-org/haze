import type { Config } from '../config/config'
import type { HttpContext } from '../http/context'
import type { MailDefinition } from '../mail/mailable'
import type { MiddlewareHandler } from '../middleware/types'
import type { MaybePromise } from '../utils'
import type { VerifyEmailPayload } from './mails'
import { useApp } from '../application'
import { ForbiddenException, InvalidSignatureException, NotFoundException, UnauthorizedException } from '../exception/exceptions'
import { Mail } from '../mail/manager'
import { getContextContainer } from '../request'
import { Router } from '../routing/router'
import { hasValidSignature, signUrl } from '../routing/signed'
import { safeEqual } from '../security/key'
import { parseDuration } from '../utils'
import { EmailVerified } from './events'
import { VerifyEmailMail } from './mails'
import { authConfigOf, currentConfig, fieldOf, resolveProvider, saveFields, sha256 } from './support'

export interface VerificationLink {
  /** 签名后的验证链接（API 地址） */
  url: string
  id: string
  hash: string
  expires: number
  signature: string
}

export interface VerificationConfig {
  /** 用户来源（config/auth.ts 的 providers），默认取默认 Guard 的 provider */
  provider?: string
  /**
   * 验证接口的路由名（如 `'api.auth.verification.verify'`，路由参数为 id、hash）；
   * 未设置时使用 path
   */
  route?: string
  /** 验证接口的路径前缀，链接为 `<path>/<id>/<hash>?expires&signature`，默认 `/email/verify` */
  path?: string
  /** 链接有效期，默认 `60m` */
  expire?: string | number
  /** 邮箱字段，默认 `email` */
  email?: string
  /** 验证时间字段，默认 `emailVerifiedAt` */
  field?: string
  /** 改写邮件中的链接（如前端页面地址，页面再把参数转交给 API） */
  url?: (link: VerificationLink, user: unknown) => MaybePromise<string>
  /** 替换默认的验证邮件 */
  mail?: MailDefinition<VerifyEmailPayload>
  /** 通过队列发送，默认 false */
  queue?: boolean
}

interface ResolvedVerification {
  config: VerificationConfig
  appConfig: Config
  email: string
  field: string
  expire: number
}

function resolveVerification(appConfig: Config = currentConfig()): ResolvedVerification {
  const config = authConfigOf(appConfig).verification ?? {}
  return {
    config,
    appConfig,
    email: config.email ?? 'email',
    field: config.field ?? 'emailVerifiedAt',
    expire: parseDuration(config.expire ?? '60m'),
  }
}

/** 邮箱地址的摘要（链接中用于确认邮箱未被修改） */
function emailHash(email: string): Promise<string> {
  return sha256(email.trim().toLowerCase())
}

/** 用户是否已验证邮箱（默认检查 emailVerifiedAt 字段） */
export function hasVerifiedEmail(user: unknown, field = resolveVerification().field): boolean {
  const value = fieldOf(user, field)
  return value !== null && value !== undefined && value !== false && value !== ''
}

/** 标记为已验证并保存（ORM 模型调用 save()），触发 EmailVerified；已验证时返回 false */
export async function markEmailAsVerified(user: unknown): Promise<boolean> {
  const resolved = resolveVerification()
  if (hasVerifiedEmail(user, resolved.field))
    return false
  await saveFields(user, {
    [resolved.field]: new Date(),
  })
  const users = resolveProvider(authConfigOf(resolved.appConfig), resolved.config.provider)
  await EmailVerified.emit({ user, id: users.ref(user).id })
  return true
}

/** 为用户生成签名的验证链接 */
export async function verificationUrl(user: unknown): Promise<VerificationLink> {
  const resolved = resolveVerification()
  const users = resolveProvider(authConfigOf(resolved.appConfig), resolved.config.provider)
  const id = users.ref(user).id
  const email = fieldOf(user, resolved.email)
  if (typeof email !== 'string' || !email)
    throw new Error(`Cannot build a verification link: user has no "${resolved.email}"`)
  const hash = await emailHash(email)
  const options = { expiresIn: resolved.expire }
  const url = resolved.config.route
    ? await (routerOf() as unknown as { signedUrl: (name: string, params: Record<string, string>, options: { expiresIn: number }) => Promise<string> }).signedUrl(resolved.config.route, { id, hash }, options)
    : await signUrl(`${(resolved.config.path ?? '/email/verify').replace(/\/+$/, '')}/${encodeURIComponent(id)}/${hash}`, { ...options, config: resolved.appConfig })
  const query = new URL(url, 'http://localhost').searchParams
  return {
    url,
    id,
    hash,
    expires: Number(query.get('expires')),
    signature: query.get('signature') ?? '',
  }
}

function routerOf(): Router {
  return getContextContainer()?.make(Router) ?? useApp().router
}

/**
 * 发送验证邮件（默认邮件为框架内置的 VerifyEmailMail，可在 verification.mail 中替换）。
 * 已验证的用户不发送，返回 false。
 */
export async function sendEmailVerification(user: unknown): Promise<boolean> {
  const resolved = resolveVerification()
  if (hasVerifiedEmail(user, resolved.field))
    return false
  const link = await verificationUrl(user)
  const url = resolved.config.url
    ? await resolved.config.url(link, user)
    : link.url
  const payload: VerifyEmailPayload = {
    appName: resolved.appConfig.get<string>('app.name', 'hazejs'),
    name: fieldOf(user, 'name') as string | undefined,
    url,
    expiresInMinutes: Math.round(resolved.expire / 60),
  }
  const pending = Mail.to(fieldOf(user, resolved.email) as string)
  const mail = resolved.config.mail ?? VerifyEmailMail
  if (resolved.config.queue)
    await pending.queue(mail, payload)
  else
    await pending.send(mail, payload)
  return true
}

/**
 * 验证接口的处理逻辑（路由参数 id、hash，链接需带有效签名）：
 * 签名无效或过期 → 403；用户不存在 → 404；邮箱已修改（hash 不符）→ 403；
 * 已登录且与链接中的用户不同 → 403。成功时标记为已验证并返回用户。
 *
 * ```ts
 * r.get('/email/verify/:id/:hash', ctx => verifyEmail(ctx)).name('verification.verify')
 * ```
 */
export async function verifyEmail<U = unknown>(ctx: HttpContext): Promise<{ user: U, verified: boolean }> {
  if (!(await hasValidSignature(ctx)))
    throw new InvalidSignatureException()
  const resolved = resolveVerification(ctx.config)
  const users = resolveProvider<U>(authConfigOf(ctx.config), resolved.config.provider)
  const id = ctx.param('id')
  const hash = ctx.param('hash')
  if (!id || !hash)
    throw new Error('verifyEmail() requires the route parameters :id and :hash')
  const user = await users.provider.retrieveById(id) ?? undefined
  if (user === undefined)
    throw new NotFoundException('用户不存在')
  const email = fieldOf(user, resolved.email)
  if (typeof email !== 'string' || !safeEqual(await emailHash(email), hash))
    throw new ForbiddenException('验证链接无效')
  // 已登录时只能验证自己的邮箱
  const current = await currentUserId(ctx)
  if (current !== undefined && current !== users.ref(user).id)
    throw new ForbiddenException('验证链接无效')
  return {
    user,
    verified: await markEmailAsVerified(user),
  }
}

async function currentUserId(ctx: HttpContext): Promise<string | undefined> {
  try {
    const id = await ctx.auth.id()
    return id === undefined
      ? undefined
      : String(id)
  }
  catch {
    // 未配置认证等情况：视为未登录
    return undefined
  }
}

/** `verified`：已登录且邮箱已验证（未登录 401，未验证 403），放在 auth 之后 */
export const verified: MiddlewareHandler = async (ctx, next) => {
  const user = await ctx.auth.user()
  if (user === undefined)
    throw new UnauthorizedException('未登录或登录已过期')
  if (!hasVerifiedEmail(user, resolveVerification(ctx.config).field))
    throw new ForbiddenException('邮箱尚未验证')
  return next()
}
