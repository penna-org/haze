# think-h3

基于 [h3 v2](https://h3.dev) 的 Node 服务端框架：IoC 容器、集中路由、分层中间件、统一异常处理，设计参考 ThinkPHP。完整设计见 [docs/design.md](docs/design.md)。

> 当前进度：M0（monorepo）、M1（运行时内核）、M2（Vite 插件 + 热更新 + CLI）、M3（Vue 全栈集成、脚手架、测试工具）、M4（代码生成、类型生成、日志、开发错误页）。

## 环境

- Node `>=22.12`（仓库 `.nvmrc` 为 22.18.0，执行 `nvm use`）
- pnpm 11

## 创建项目

```bash
pnpm create think-h3 my-app            # 交互选择模板
pnpm create think-h3 my-app -t api     # 纯后端 API
pnpm create think-h3 my-app -t vue     # Vue 3 全栈（同仓库、同端口、一次构建）
```

> 包尚未发布到 npm，仓库内可用 `node packages/create/bin/create-think-h3.mjs <dir> -t vue` 体验。

在已有的 Vue 项目中使用：

```ts
// vite.config.ts
export default defineConfig({
  plugins: [
    vue(),
    thinkH3()
  ], // 开发时 /api/** 交给 server/ 下的后端；vite build 产出 dist/client + dist/server
})

// think.config.ts
export default defineThinkConfig({ srcDir: 'server' })
```

## 部署

```bash
npx think-h3 build --preset <node|bun|deno|docker|cloudflare|vercel|netlify|aws-lambda>
```

也可在 `think.config.ts` 中设置 `preset`。纯后端与 Vue 全栈项目均支持，构建结束会提示运行 / 部署方式。

## 常用命令

```bash
pnpm install
pnpm build       # tsdown 构建 packages/*
pnpm test        # 先构建，再跑 vitest（core / vite / playground）
pnpm typecheck
pnpm lint
```

在 playground 中体验框架命令：

```bash
cd playground
pnpm dev          # think-h3 dev：修改代码即时生效，进程不重启
pnpm routes       # think-h3 route:list
pnpm build        # think-h3 build → dist/index.mjs
pnpm start        # think-h3 start
pnpm test         # think-h3 test（vitest）
npx think-h3 typegen                         # 配置键 / 路由名类型（dev 时自动生成）
npx think-h3 make:controller Order --resource # make:service / repository / middleware / provider / validate / test / config / route
npx think-h3 stub:publish                    # 导出 stub 到 stubs/ 以定制生成代码
```

## 目录

```
packages/orm/    @think-h3/orm  基于 drizzle 的 Db 查询构造器 + Model（MySQL / PostgreSQL / SQLite）；
                 @think-h3/orm/mongo 为同形态的 MongoDB 适配器（Mongo / MongoModel）
packages/create/ create-think-h3 脚手架与 api / vue 模板
packages/testing/ @think-h3/testing  useTestApp / createTestApp / defineThinkTestConfig
packages/cli/    @think-h3/cli  命令行 think-h3（dev / build / start / test / route:list / typegen / make:*）
packages/vite/   @think-h3/vite Vite 插件（virtual:think/*）、热替换开发服务器、生产构建
packages/core/   @think-h3/core 运行时内核
  src/container/   依赖注入（inject()、Singleton / Request / Transient 作用域）
  src/config/      配置仓库、.env 加载、env() 类型转换
  src/routing/     defineRoutes / group / resource / 命名路由 → 编译为 h3 路由
  src/middleware/  别名、分组、参数化中间件，类中间件支持注入
  src/exception/   HttpException 体系 + ExceptionHandler（report / render）
  src/http/        HttpContext、统一响应格式、Standard Schema 校验
  src/application.ts  生命周期：env → config → providers → h3
playground/      ThinkPHP 风格的示例项目（用户 CRUD），也是集成测试
```

## 快速示例

```ts
// route/api.ts
export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.resource('/users', UserController).validateMember({ params: UserIdParams })
  })
})

// app/controller/UserController.ts
export class UserController {
  static middleware = [
    {
      use: 'auth',
      except: ['index', 'show']
    }
  ]

  private users = inject(UserService)

  show(ctx: HttpContext<{ params: typeof UserIdParams }>) {
    return this.users.find(ctx.validated.params.id) // → { code: 0, message: 'ok', data: {...} }
  }
}
```

更多用法参见 `playground/` 与 `packages/core/test/`。
