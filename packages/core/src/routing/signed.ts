import type { Config } from '../config/config'
import type { HttpContext } from '../http/context'
import type { MiddlewareHandler } from '../middleware/types'
import { InvalidSignatureException } from '../exception/exceptions'
import { appKey, previousAppKeys, sign, verify } from '../security/key'
import { parseDuration } from '../utils'

export interface SignedUrlOptions {
  /** 有效期：`'30m'`、`'7d'` 或秒数；省略时链接永久有效 */
  expiresIn?: string | number
  /** 过期时间点（Date 或毫秒时间戳），与 expiresIn 二选一 */
  expiresAt?: Date | number
  /** 附加的查询参数（一并签名） */
  query?: Record<string, string | number>
  /** 是否生成绝对链接（前缀为 app.url / APP_URL），默认在设置了 APP_URL 时为 true */
  absolute?: boolean
}

export interface SignatureOptions {
  /** 校验时忽略的查询参数（如前端追加的 utm_*） */
  ignore?: string[]
}

/** 区分用途，避免与其它 APP_KEY 签名（Cookie、存储临时链接）混用 */
const PURPOSE = 'hazejs:signed-url\n'
const RESERVED = ['expires', 'signature']

/** 过期时间（Unix 秒），没有设置时为 undefined */
export function expiresOf(options: Pick<SignedUrlOptions, 'expiresIn' | 'expiresAt'>): number | undefined {
  if (options.expiresAt !== undefined)
    return Math.floor(Number(options.expiresAt) / 1000)
  if (options.expiresIn !== undefined)
    return Math.floor(Date.now() / 1000) + parseDuration(options.expiresIn)
  return undefined
}

/** 签名内容：路径 + 按键排序的查询参数（不含 signature） */
function payload(url: URL, ignore: string[] = []): string {
  const entries = [...url.searchParams]
    .filter(([key]) => key !== 'signature' && !ignore.includes(key))
    .sort(([a, av], [b, bv]) => a < b
      ? -1
      : a > b
        ? 1
        : av < bv
          ? -1
          : av > bv
            ? 1
            : 0)
  const search = new URLSearchParams(entries).toString()
  return `${PURPOSE}${url.pathname}${search
    ? `?${search}`
    : ''}`
}

/**
 * 为站内路径（可带查询参数）追加 expires 与 signature。路由的签名链接请用
 * `router.signedUrl()` / `router.temporarySignedUrl()`。
 */
export async function signUrl(path: string, options: SignedUrlOptions & { config?: Config } = {}): Promise<string> {
  const url = new URL(path, 'http://localhost')
  for (const key of RESERVED) {
    if (url.searchParams.has(key) || (options.query && key in options.query))
      throw new Error(`"${key}" is reserved for signed URLs`)
  }
  for (const [key, value] of Object.entries(options.query ?? {}))
    url.searchParams.set(key, String(value))
  const expires = expiresOf(options)
  if (expires !== undefined)
    url.searchParams.set('expires', String(expires))
  url.searchParams.set('signature', await sign(payload(url), appKey(options.config)))

  const base = options.config?.get<string | undefined>('app.url', undefined)
  const absolute = options.absolute ?? Boolean(base)
  if (absolute && !base)
    throw new Error('Cannot generate an absolute signed URL: set APP_URL (config/app.ts url)')
  const relative = `${url.pathname}${url.search}`
  return absolute
    ? `${base!.replace(/\/+$/, '')}${relative}`
    : relative
}

/**
 * 校验 URL 的签名与有效期：签名覆盖路径与全部查询参数（`ignore` 中的除外），
 * 依次尝试 APP_KEY 与 `app.previousKeys`（密钥轮换期间旧链接仍然有效）。
 */
export async function verifySignedUrl(input: string | URL, options: SignatureOptions & { config?: Config } = {}): Promise<boolean> {
  const url = new URL(input, 'http://localhost')
  const signature = url.searchParams.get('signature')
  if (!signature)
    return false
  const expires = url.searchParams.get('expires')
  if (expires !== null && !(Number(expires) > Date.now() / 1000))
    return false
  const content = payload(url, options.ignore)
  for (const key of [
    appKey(options.config),
    ...previousAppKeys(options.config),
  ]) {
    if (await verify(content, signature, key))
      return true
  }
  return false
}

/** 当前请求的 URL 是否带有有效签名（使用原始请求 URL，多应用剥离前缀不影响校验） */
export function hasValidSignature(ctx: HttpContext, options: SignatureOptions = {}): Promise<boolean> {
  return verifySignedUrl(ctx.req.url, { ...options, config: ctx.config })
}

/**
 * `signed` 中间件：签名无效、被篡改或已过期时返回 403（InvalidSignatureException）。
 * 参数为校验时忽略的查询参数：`signed:utm_source,utm_medium`。
 */
export const signed: MiddlewareHandler = async (ctx, next, ...ignore) => {
  if (!(await hasValidSignature(ctx, { ignore })))
    throw new InvalidSignatureException()
  return next()
}
