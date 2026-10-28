import type { HttpContext } from '@hazejs/core'

export class PostController {
  index(ctx: HttpContext) {
    return {
      title: ctx.config.get('blog.title', ''),
      perPage: ctx.config.get('blog.perPage', 0),
      message: 'posts v1',
    }
  }

  show(ctx: HttpContext) {
    return {
      id: ctx.param('id'),
    }
  }
}
