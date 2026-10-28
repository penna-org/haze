import type { HttpContext, Middleware, Next } from '@hazejs/core'
import { Config, inject, UnauthorizedException } from '@hazejs/core'
import { UserRepository } from '~/app/repository/UserRepository'

/** 演示用：`Authorization: Bearer <API_TOKEN>` 视为 1 号用户登录 */
export class Authenticate implements Middleware {
  private config = inject(Config)
  private users = inject(UserRepository)

  handle(ctx: HttpContext, next: Next) {
    const token = ctx.header('authorization')?.replace(/^Bearer /, '')
    if (!token || token !== this.config.get('auth.token'))
      throw new UnauthorizedException('请先登录')

    ctx.set('user', this.users.find(1)!)
    return next()
  }
}
