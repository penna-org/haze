import type { setCookie } from 'h3'

export type CookieOptions = NonNullable<Parameters<typeof setCookie>[3]>

/** 默认 Cookie 选项：httpOnly、SameSite=Lax、根路径；生产环境加 Secure（可在 config/app.ts 的 cookie 中覆盖） */
export function defaultCookieOptions(production: boolean): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
  }
}

/** 序列化 Set-Cookie（响应已生成后追加 Cookie 时使用，如 Session 写回） */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (options.maxAge !== undefined)
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  if (options.expires)
    parts.push(`Expires=${options.expires.toUTCString()}`)
  if (options.domain)
    parts.push(`Domain=${options.domain}`)
  if (options.path)
    parts.push(`Path=${options.path}`)
  if (options.httpOnly)
    parts.push('HttpOnly')
  if (options.secure)
    parts.push('Secure')
  if (options.sameSite) {
    const sameSite = options.sameSite === true
      ? 'Strict'
      : `${options.sameSite[0].toUpperCase()}${options.sameSite.slice(1)}`
    parts.push(`SameSite=${sameSite}`)
  }
  if (options.partitioned)
    parts.push('Partitioned')
  return parts.join('; ')
}

/** 保证 Response 的响应头可修改（h3 对无额外头的 JSON 响应复用了冻结的 Headers） */
export function mutableResponse(response: Response): Response {
  try {
    response.headers.set('x-haze-probe', '1')
    response.headers.delete('x-haze-probe')
    return response
  }
  catch {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  }
}
