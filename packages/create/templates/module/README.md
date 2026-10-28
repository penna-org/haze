# {{name}}

一个 hazejs 模块：为启用它的项目带来路由、中间件、默认配置与数据库迁移。

## 在项目中启用

```bash
pnpm add {{name}}
```

```ts
// config/modules.ts
import { defineModulesConfig } from '@hazejs/core'
import posts from '{{name}}'

export default defineModulesConfig({
  modules: [
    // 前缀、路由名前缀、额外中间件都可以在启用时调整
    posts({
      prefix: '/api/{{name}}',
      middleware: ['throttle:60,60'],
      perPage: 10
    }),
  ],
})
```

```bash
pnpm haze db:migrate   # 先执行模块的迁移（记录在 __drizzle_migrations_{{moduleTable}}），再执行项目自己的
pnpm haze module:list  # 查看已启用的模块、前缀、路由数与迁移目录
```

模块提供的内容：

| 内容 | 位置 |
|------|------|
| 路由 `GET/POST /posts`（路由名 `{{moduleName}}.posts.*`） | `src/routes.ts` |
| 中间件别名 `{{moduleName}}.json` | `src/middleware/EnsureJson.ts` |
| 默认配置 `{{moduleName}}.perPage`（项目的 `config/{{moduleName}}.ts` 可覆盖） | `src/config.ts` |
| 数据表 `{{moduleTable}}_posts` | `src/schema.ts` + `database/migrations` |

配置的类型通过 `declare module '@hazejs/core'` 扩充 `ConfigSchema`，随类型声明发布，项目中 `config('{{moduleName}}.perPage')` 直接得到 `number`。

## 开发

```bash
pnpm test         # tests/app 是一个最小的宿主应用，在 config/modules.ts 中启用本模块（源码）
pnpm typecheck
pnpm build        # tsdown → dist/index.mjs + index.d.mts
pnpm db:generate  # 修改 src/schema.ts 后生成迁移到 database/migrations
```

- 迁移目录用 `new URL('../database/migrations', import.meta.url)` 声明，并随包发布（`package.json` 的 `files`）。宿主项目生产构建时会把这些迁移打包进产物，`migrate.mjs` 可直接执行。
- `package.json` 中的 `"hazejs": { "module": true }` 让宿主项目的构建识别本包。
- 在 pnpm workspace 中以 `workspace:` / `link:` 引用本包时，运行 `pnpm dev`（`tsdown --watch`），宿主项目的开发服务器会在 `dist` 变化后热替换。

## 发布

```bash
pnpm build && npm publish
```
