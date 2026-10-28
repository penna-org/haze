import type { HttpContext } from '@think-h3/core'
import { Hash, Storage, UnauthorizedException, validate } from '@think-h3/core'
import UserRegistered from '~/app/event/UserRegistered'
import { User } from '~/app/model/User'
import { AvatarSchema, LoginSchema, RegisterSchema } from '~/app/validate/auth'

/**
 * JWT 登录示例（config/auth.ts 的 api Guard）：
 * 客户端保存 login / register 返回的 token，之后请求带上 `Authorization: Bearer <token>`
 */
export class AuthController {
  async register(ctx: HttpContext) {
    const { password, ...input } = await validate(RegisterSchema, await ctx.body())
    const user = await User.create({ ...input, password: await Hash.make(password) })
    // 事件：监听器投递欢迎邮件任务、推送实时消息（app/listener）
    await UserRegistered.emit({ userId: user.id, email: user.email })
    return ctx.created({
      user,
      ...await ctx.auth.jwt().login(user),
    })
  }

  async login(ctx: HttpContext) {
    const issued = await ctx.auth.jwt().attempt(await validate(LoginSchema, await ctx.body()))
    if (!issued)
      throw new UnauthorizedException('邮箱或密码错误')
    return issued
  }

  /** 需要 auth 中间件：未登录时返回 401 */
  me(ctx: HttpContext) {
    return ctx.auth.user()
  }

  /** 上传头像（multipart 字段 avatar）：保存到 public 磁盘，经 /storage/<path> 访问 */
  async avatar(ctx: HttpContext) {
    const { avatar } = await validate(AvatarSchema, await ctx.body())
    const path = await (await ctx.file('avatar'))!.store('avatars', 'public')
    return ctx.created({
      path,
      url: Storage.disk('public').url(path),
      size: avatar.size,
    })
  }
}
