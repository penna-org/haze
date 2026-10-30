# 自动导入

开启自动导入后，控制器、服务、事件、任务以及 hazejs 的常用 API 都无需手写 `import`。`haze()` Vite 插件在编译代码时补上导入，同时生成一份类型声明，编辑器补全与类型检查都不受影响：类可以直接用作类型，泛型保留约束，默认导出也有名字。

```ts
// route/api.ts：没有任何 import
export default defineRoutes((r) => {
  r.get('/users/:id', [UserController, 'show'])
})

// app/controller/UserController.ts
export class UserController {
  private users = inject(UserService)

  show(ctx: HttpContext) {
    return this.users.find(Number(ctx.param('id'))) ?? notFound()
  }
}

function notFound(): never {
  throw new NotFoundException()
}
```

自动导入**默认关闭**。手写的 import 仍然有效，已有项目可以先开启，再逐步删掉 import。

## 安装

```bash
pnpm add -D @hazejs/auto-import
```

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  autoImport: true,
})
```

新项目可以在创建时开启：`pnpm create hazejs my-app --auto-import`（或在交互提示中选择“是”）。

凡是 `haze()` 插件运行的地方都支持自动导入：`haze dev`、`haze build`、使用 `defineHazeTestConfig()` 的 Vitest，以及所有加载应用的命令行命令。全栈项目中只作用于后端：前端（Vite 的 `client` 环境）不会被注入，也看不到这些声明。

## 自动导入哪些名字

**项目代码**：以下目录（含子目录）中文件的全部导出，以及本地模块中的同名目录（`modules/<name>/app/...`）：

`app/controller`、`app/service`、`app/repository`、`app/model`、`app/middleware`、`app/interceptor`、`app/validate`、`app/event`、`app/job`、`app/mail`、`app/notification`、`app/resource`

- 具名导出保留原名：`export class UserService` → `UserService`。
- 默认导出取声明的名字（`export default class Post` → `Post`），匿名时取文件名：`app/event/UserRegistered.ts` 中的 `export default defineEvent(...)` → `UserRegistered`，`app/job/send-receipt.ts` → `sendReceipt`，`user/index.ts` → `user`。
- 只有类型的导出（`interface`、`type`）只能用在类型位置，不会产生运行时导入。

框架自己发现的目录（`app/listener`、`app/policy`、`app/provider`、`config`、`route`）不扫描：没有代码会导入它们。

**框架 API**：已安装且提供了预设的 `@hazejs/*` 包会加入各自精选的 API：

| 包 | 示例 |
|----|------|
| `@hazejs/core` | `defineRoutes`、`defineConfig`、`defineProvider`、`defineEvent`、`defineListener`、`defineJob`、`definePolicy`、各个 `define*Config`、`env`、`inject`、`validate`、`useApp`，`Config`、`Logger`、`Router`、`Cache`、`Queue`、`Mail`、`Hash`、`Events`、`Gate` 等服务，HTTP 异常类、`ExceptionHandler`、`ResponseFormatter`、`HttpContext`，以及 `Next`、`Middleware`、`ControllerMiddleware` 等类型 |
| `@hazejs/orm` | `Model`、`Db`、`defineDatabaseConfig`、`defineFactory`、`transaction`、`databaseProvider`、`modelUserProvider`、各个 `database*Store`、`refreshDatabase`、`ModelNotFoundException`、`ModelQuery`、`Paginated` |

预设不收录与 Node.js / Web 全局名冲突的名字（`Storage`、`Lock` 是 `@types/node` 中的全局类型，需要从 `@hazejs/core` 手写导入），也不收录过于通用的小写函数（`t`、`raw`、`when`、`cache`、`can`）。

## 类型

插件把全局声明写到 `.haze/types/auto-imports.d.ts`。`create-hazejs` 创建的项目的 `tsconfig.json` 已经包含 `.haze/types/**/*.d.ts`，其它项目需要自己加上。

开发服务器启动时、新增 / 重命名 / 删除导出时以及 `haze typegen` 都会更新这个文件。`.haze` 不进入 git，CI 中先运行 `haze typegen` 再运行 `tsc`：

```json
{
  "scripts": {
    "typecheck": "haze typegen && tsc --noEmit"
  }
}
```

“转到定义”会跳到原文件。不在名单中的名字（拼写错误、文件不在扫描目录中）照常由 TypeScript 报错。

## 配置

`autoImport: true` 使用默认配置，传入对象可以修改：

```ts
export default defineHazeConfig({
  autoImport: {
    // 额外扫描 app/support（相对 srcDir）；设置后替换默认目录
    dirs: ['app/controller/**', 'app/service/**', 'app/support'],
    // 其它包的自动导入
    imports: [
      { from: 'valibot', imports: [['*', 'v']] }, // import * as v from 'valibot'
      { from: 'dayjs', imports: [['default', 'dayjs']] }, // import dayjs from 'dayjs'
      { from: 'zod', imports: ['z', { name: 'ZodType', type: true }] },
    ],
    // 框架预设：默认为所有已安装的 @hazejs/* 包；[] 关闭
    presets: ['@hazejs/core'],
    // 不自动导入的名字
    ignore: ['Logger'],
  },
})
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `dirs` | 上面的目录 | 相对 `srcDir` 的目录 glob。`app/service` 只扫描第一层，`app/service/**` 包含子目录，最后一段带扩展名时按文件 glob 处理。重名时排在前面的优先 |
| `imports` | `[]` | `{ from, imports }` 条目。每一项是名字、`[name, as]`（`'default'` 与 `'*'` 表示默认导入与命名空间导入）或 `{ name, as?, type? }`（`type: true` 表示只有类型） |
| `presets` | 已安装且提供了预设的 `@hazejs/*` 包 | 包名。预设是 `<包名>/auto-imports` 的默认导出：一个 `{ from, imports }` 对象或其数组。第三方包也可以提供预设，在这里列出即可 |
| `ignore` | `[]` | 永远不自动导入的名字 |
| `exclude` | `['database/schema/**', 'modules/*/database/schema/**']` | 不注入导入的文件（相对 `srcDir` 的 glob） |

同一个名字来自多处时，项目目录优先于 `imports`，`imports` 优先于预设，开发服务器会打印警告并列出相关的文件。重命名其中一个，或把名字加入 `ignore`。

## 不能使用自动导入的文件

导入由 Vite 补上，由其它工具加载的文件需要照常手写 import：

- `haze.config.ts`、`vite.config.ts`、`vitest.config.ts`（由 Vite 的配置加载器加载）；
- `database/schema/*.ts`（`haze db:generate` 中由 drizzle-kit 加载），因此默认被排除。

TypeScript 无法区分这些文件，在其中漏写 import 只会在运行时报错。

## 生成代码

`haze make:*` 读取 `haze.config.ts`。开启自动导入后，生成的文件省略所有会被自动导入的 import，其余保留：

```ts
// haze make:policy Post：没有 import
export default definePolicy(Post, {
  viewAny: allowGuest(() => true),
  // ...
})
```

## 提示

- 手写的 import 仍然有效并且优先：文件中已经导入或声明的名字不会再被注入。
- 导入在 TypeScript 编译之后补上，只用作类型的类（配合 `inject()` 的 `private users: UserService`）不会产生运行时导入。
- 自动导入容易在不知不觉中形成循环依赖。`inject()` 延迟解析依赖，服务之间的循环引用没有问题；但模块加载时就执行的代码（如 `static middleware = [Authenticate]`）仍然要求另一个模块先加载完成。
