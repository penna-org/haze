import type { HttpContext } from '@hazejs/core'
import { HttpException } from '@hazejs/core'
import { Db } from '@hazejs/orm'
import { posts } from '../schema'

export class PostController {
  /** GET /posts：每页条数来自配置（模块默认值 → 启用选项 → 宿主项目的 config/{{moduleName}}.ts） */
  async index(ctx: HttpContext) {
    return Db.table(posts).order('id', 'desc').limit(ctx.config.get('{{moduleName}}.perPage')).select()
  }

  /** POST /posts */
  async store(ctx: HttpContext) {
    const { title } = await ctx.body<{ title?: string }>()
    if (!title?.trim())
      throw new HttpException('title is required', { status: 422 })
    const [post] = await Db.table(posts).insert({
      title: title.trim(),
      createdAt: new Date(),
    })
    return post
  }
}
