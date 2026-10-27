import type { Application } from '../application'
import { mockEvent } from 'h3'
import { HttpContext } from '../http/context'
import { JwtGuard } from './guards'

/**
 * 测试用：不经过登录接口，为用户生成可直接附在请求上的凭据。
 * JWT Guard 签发真实令牌（authorization 头），Session Guard 生成真实的会话 Cookie（cookie 头）。
 * `@think-h3/testing` 的 `actingAs()` 基于此实现。
 */
export async function issueTestCredentials(app: Application, user: unknown, guardName?: string): Promise<Record<string, string>> {
  const ctx = new HttpContext(mockEvent('/'), app.container.createChild(), { config: app.config })
  const guard = ctx.auth.guard(guardName)
  if (guard instanceof JwtGuard)
    return { authorization: `Bearer ${(await guard.login(user)).token}` }
  await guard.login(user)
  // 执行会话写回，取出 Set-Cookie
  let response = new Response(null)
  for (const hook of [...ctx.responseHooks].reverse())
    response = (await hook(response)) ?? response
  const cookie = response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')
  return cookie
    ? { cookie }
    : {}
}
