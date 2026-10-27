# think-h3

基于 [h3 v2](https://h3.dev) 的 Node 服务端框架：IoC 容器、集中路由、分层中间件、统一异常处理，设计参考 ThinkPHP。完整设计见 [docs/design.md](docs/design.md)。

> 当前进度：M0（monorepo 基础设施）+ M1（运行时内核）。CLI、热更新、Vite 插件属于 M2/M3。

## 环境

- Node `>=22.12`（仓库 `.nvmrc` 为 22.18.0，执行 `nvm use`）
- pnpm 11

## 常用命令

```bash
pnpm install
pnpm test        # vitest（core + playground）
pnpm typecheck
pnpm lint
pnpm build       # tsdown 构建 packages/*
```

## 目录

```
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
