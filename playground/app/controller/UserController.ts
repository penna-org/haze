import type { ControllerMiddleware, HttpContext } from '@think-h3/core'
import type { UserIdParams } from '~/app/validate/user'
import { inject, validate } from '@think-h3/core'
import { UserService } from '~/app/service/UserService'
import { CreateUserSchema, UpdateUserSchema } from '~/app/validate/user'

type WithId = HttpContext<{ params: typeof UserIdParams }>

/** 控制层：接收参数 → 调用服务 → 返回数据（统一响应格式由框架包装） */
export class UserController {
  static middleware: ControllerMiddleware[] = [
    {
      use: 'auth',
      except: ['index', 'show'],
    },
  ]

  private users = inject(UserService)

  index() {
    return this.users.list()
  }

  /** 参数已由路由上的 `.validate()` 校验并转换为 number */
  show(ctx: WithId) {
    return this.users.find(ctx.validated.params.id)
  }

  /** 也可以在控制器内手动校验 */
  async store(ctx: HttpContext) {
    const input = await validate(CreateUserSchema, await ctx.body())
    return ctx.created(this.users.create(input))
  }

  async update(ctx: WithId) {
    const input = await validate(UpdateUserSchema, await ctx.body())
    return this.users.update(ctx.validated.params.id, input)
  }

  destroy(ctx: WithId) {
    this.users.delete(ctx.validated.params.id)
    return ctx.noContent()
  }

  me(ctx: HttpContext) {
    return ctx.get('user')
  }
}
