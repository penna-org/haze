import type { PostsConfig } from './config'
import { defineModule } from '@hazejs/core'
import { defaults } from './config'
import { EnsureJson } from './middleware/EnsureJson'
import routes from './routes'

export type { PostsConfig } from './config'
export { posts } from './schema'

/** 启用时的选项（与 prefix / as / middleware 等挂载选项一起传入） */
export interface PostsOptions {
  perPage?: number
}

/**
 * 宿主项目在 config/modules.ts 中启用：
 *
 * ```ts
 * import posts from '{{name}}'
 * export default defineModulesConfig({ modules: [posts({ prefix: '/api/{{name}}', perPage: 10 })] })
 * ```
 */
export default defineModule({
  name: '{{moduleName}}',
  prefix: '/api/{{name}}',
  config: { '{{moduleName}}': defaults },
  routes: [routes],
  middleware: {
    alias: { '{{moduleName}}.json': EnsureJson },
  },
  // 迁移随包发布；宿主项目的 haze db:migrate / 生产迁移入口会先执行它（记录在 __drizzle_migrations_{{moduleTable}}）
  migrations: new URL('../database/migrations', import.meta.url),
  options: (options: PostsOptions) => options.perPage
    ? {
        config: {
          '{{moduleName}}': { perPage: options.perPage } satisfies Partial<PostsConfig>,
        },
      }
    : undefined,
})
