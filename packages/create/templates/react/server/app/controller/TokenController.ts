import type { HttpContext } from '@hazejs/core'
import { NotFoundException, validate } from '@hazejs/core'
import { CreateTokenSchema } from '~/app/validate/auth'

/**
 * 个人访问令牌（config/auth.ts 的 token Guard）：登录后为脚本 / CLI 签发长期令牌，
 * 请求时带上 `Authorization: Bearer <token>`，可随时吊销。
 */
export class TokenController {
  /** 当前用户的令牌（不含明文与摘要） */
  async index(ctx: HttpContext) {
    const tokens = await ctx.auth.token().tokens().list((await ctx.auth.user())!)
    return tokens.map(({ token: _hash, ...token }) => token)
  }

  /** 签发令牌：明文只在这次响应中返回 */
  async store(ctx: HttpContext) {
    const { name, abilities, expiresInDays } = await validate(CreateTokenSchema, await ctx.body())
    const issued = await ctx.auth.token().createToken((await ctx.auth.user())!, name, {
      abilities,
      expiresIn: expiresInDays
        ? `${expiresInDays}d`
        : undefined,
    })
    const { token: _hash, ...accessToken } = issued.accessToken
    return ctx.created({ token: issued.plainTextToken, accessToken })
  }

  /** 吊销自己的令牌 */
  async destroy(ctx: HttpContext) {
    if (!(await ctx.auth.token().tokens().revoke(ctx.param('id')!, (await ctx.auth.user())!)))
      throw new NotFoundException('令牌不存在')
    return ctx.noContent()
  }
}
