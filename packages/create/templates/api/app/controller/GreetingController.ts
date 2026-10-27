import type { HttpContext } from '@think-h3/core'
import type { GreetSchema } from '~/app/validate/greeting'
import { Config, inject } from '@think-h3/core'
import { GreetingService } from '~/app/service/GreetingService'

/** 控制层：接收参数 → 调用服务 → 返回数据（框架统一包装为 { code, message, data }） */
export class GreetingController {
  private greeting = inject(GreetingService)
  private config = inject(Config)

  index() {
    return {
      app: this.config.get('app.name'),
      message: this.greeting.greet('think-h3'),
    }
  }

  store(ctx: HttpContext<{ body: typeof GreetSchema }>) {
    return {
      message: this.greeting.greet(ctx.validated.body.name),
    }
  }
}
