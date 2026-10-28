import type { HttpContext } from '@hazejs/core'
import type { UserIdParams } from '~/app/validate/user'
import { validate } from '@hazejs/core'
import { User } from '~/app/model/User'
import { UserResource } from '~/app/resource/UserResource'
import { CreateUserSchema, UpdateUserSchema } from '~/app/validate/user'

type WithId = HttpContext<{ params: typeof UserIdParams }>

/** RESTful 资源控制器：路由见 route/api.ts 中的 r.resource('/users', UserController) */
export class UserController {
  async index(ctx: HttpContext) {
    // API 资源（app/resource/UserResource.ts）控制输出字段；分页输出 { data, meta, links }
    return UserResource.collection(await User.order('id', 'desc').paginate(Number(ctx.query('page') ?? 1), 20))
  }

  show(ctx: WithId) {
    return User.findOrFail(ctx.validated.params.id)
  }

  async store(ctx: HttpContext) {
    const input = await validate(CreateUserSchema, await ctx.body())
    return ctx.created(await User.create(input))
  }

  async update(ctx: WithId) {
    const user = await User.findOrFail(ctx.validated.params.id)
    // 授权：app/policy/UserPolicy.ts
    await ctx.authorize('update', user)
    user.fill(await validate(UpdateUserSchema, await ctx.body()))
    return user.save()
  }

  async destroy(ctx: WithId) {
    const user = await User.findOrFail(ctx.validated.params.id)
    await ctx.authorize('delete', user)
    await user.delete()
    return ctx.noContent()
  }
}
