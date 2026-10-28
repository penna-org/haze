# 自定义命令

除了内置的 `haze` 命令，还可以编写自己的命令，用来修数据、出报表、导入数据或做日常维护。命令就是 `app/command` 下默认导出 `defineCommand()` 的文件。命令运行时应用已经启动，模型、门面和容器的用法与请求中完全一致。同一个命令既可以用 `haze <name>` 直接运行源码，也可以在构建产物中用 `node dist/worker.mjs command <name>` 运行。

`haze repl` 会打开一个交互式命令行，里面可以直接使用已启动的应用、各个门面和你的模型。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 定义命令

用命令生成：

```bash
npx haze make:command SendReport
```

```ts
// app/command/SendReport.ts
import { defineCommand, Mail } from '@hazejs/core'
import ReportMail from '~/app/mail/ReportMail'
import { User } from '~/app/model/User'

export default defineCommand({
  description: '发送日报邮件',
  args: {
    to: { type: 'positional', description: '收件人' },
    format: { type: 'enum', options: ['html', 'text'], default: 'html' },
    dryRun: { type: 'boolean', alias: 'd', description: '只打印，不发送' },
  },
  async run(args, ctx) {
    const users = await User.count()
    if (args.dryRun) {
      ctx.logger.info(`共 ${users} 个用户，将发送给 ${args.to}`)
      return
    }
    await Mail.to(args.to).send(ReportMail, { users })
    ctx.logger.success(`日报已发送给 ${args.to}`)
  },
})
```

```bash
npx haze send:report ops@example.com --dry-run
npx haze send:report --help
```

命令会被自动发现，子目录中的文件也包括在内。`app/command` 下默认导出不是命令的模块（例如几个命令共用的辅助函数）会被忽略。

## 命令名

没有设置 `name` 时，命令名由文件路径推导：

| 文件 | 命令 |
| --- | --- |
| `app/command/Inspire.ts` | `inspire` |
| `app/command/SendReport.ts` | `send:report` |
| `app/command/SendDailyReport.ts` | `send:daily-report` |
| `app/command/db/Cleanup.ts` | `db:cleanup` |
| `app/command/db/PruneOld.ts` | `db:prune-old` |

- 顶层文件按第一个单词分组；放在子目录中时，子目录就是分组。
- 末尾的 `Command` 会被去掉：`SendReportCommand.ts` 对应 `send:report`。
- `defineCommand({ name: 'report:send', ... })` 可以直接指定命令名。

命令名不能重复。与内置命令（如 `make:model`）同名的命令会被跳过，并打印一条警告。

## 参数

`args` 的写法与 `haze` 命令行所用的 [citty](https://github.com/unjs/citty) 相同，所以 `haze <name> --help` 会像内置命令一样列出这些参数：

| 类型 | 示例 | 解析结果 |
| --- | --- | --- |
| `positional` | `haze send:report ops@example.com` | `string`；除非设置了 `required: false` 或 `default`，否则必填 |
| `string` | `--to ops@example.com`、`--to=ops@example.com` | `string`；没传且没有 `default` 时为 `undefined` |
| `boolean` | `--dry-run`、`-d`、`--no-dry-run` | `boolean`（没传时为 `false`） |
| `enum` | `--format text` | `options` 中的一个值，其他值会报错 |

每个参数都可以设置 `description`、`default`、`alias`（一个或多个短名称，位置参数不支持）、`required` 和 `valueHint`。选项名用驼峰或短横线写法都可以（`--dryRun` 和 `--dry-run` 都对应 `dryRun`）。位置参数按定义顺序依次赋值，`args._` 中保存全部位置参数，包括多出来的。

解析后的 `args` 类型由定义推导：必填的位置参数是 `string`，枚举是各个选项组成的联合类型，没有默认值的选项可能是 `undefined`。

缺少必填参数或枚举值无效时，会打印命令用法并以退出码 1 结束，不会调用 `run()`。

## 命令上下文

`run(args, ctx)` 的第二个参数包含：

| 属性 | 说明 |
| --- | --- |
| `ctx.app` | 已启动的应用，可以 `ctx.app.make(Service)`、读取 `ctx.app.config` |
| `ctx.logger` | 应用的日志器 |
| `ctx.name` | 命令名 |
| `ctx.rawArgs` | 命令名之后未经解析的参数 |
| `ctx.confirm(message, initial?)` | 是 / 否提问，返回 `boolean` |
| `ctx.ask(message, { default?, placeholder? })` | 文本输入，返回 `string` |
| `ctx.choice(message, options, initial?)` | 从 `options` 中选择一项，返回选中的值 |
| `ctx.prompt(message, options)` | 底层的 consola `prompt()`，用于 `multiselect` 等其他形式 |

用户按 Ctrl+C 取消提问时会抛出异常，命令以退出码 1 结束。无人值守运行的命令（cron、CI）不要提问，可以改为提供 `--force` 之类的选项。

在 `run()` 中，`useApp()`、`config()` 以及各个门面（`Cache`、`Queue`、`Mail`、`Db` 等）的用法与请求中相同。

## 退出码

- `run()` 没有返回值：退出码为 `0`。
- `run()` 返回数字：以该数字作为退出码。
- `run()` 抛出异常：记录错误，退出码为 `1`。

`run()` 结束后会释放应用（关闭数据库连接、队列与邮件传输），然后退出进程。

## 运行命令

### 开发环境

```bash
npx haze --help                     # 内置命令与自定义命令
npx haze send:report --help         # 查看某个命令的用法
npx haze send:report ops@example.com
npx haze send:report ops@example.com --root ./apps/api
```

与 `queue:work` 一样，命令在与开发服务器相同的 Vite 模块图中直接运行 TypeScript 源码，不监听端口。`--root` 由 `haze` 处理，不会传给命令；命令自己定义了 `root` 参数时除外。

命令行只在需要时才加载 `app/command`：运行自定义命令，或者打印命令列表时。运行内置命令不会因此启动应用。

### 生产环境

常驻进程型的预设（`node`、`bun`、`deno`、`docker`）会把自定义命令打包进 `worker.mjs`，运行时不需要源码和命令行工具：

```bash
node dist/worker.mjs command                          # 列出命令
node dist/worker.mjs command send:report --help
node dist/worker.mjs command send:report ops@example.com --dry-run
```

全栈项目以及 `deno` / `docker` 预设下，`worker.mjs` 位于 `dist/server/`。参数解析规则与开发环境相同，进程以命令的退出码退出。

命令模块按需加载，Web 服务进程（`index.mjs`）不会执行它们。Serverless 与 Edge 预设没有命令入口。

## REPL

```bash
npx haze repl
```

```text
ℹ Available: app, config, inject, useApp, Cache, Queue, Events, Storage, Mail, Db, User
haze> await User.count()
1
haze> await User.findOrFail(1)
User {
  id: 1,
  name: 'Ada',
  email: 'ada@example.com',
  ...
}
haze> config('app.name')
'my-app'
```

REPL 会像 `haze dev` 一样启动应用（不监听端口），并提供以下变量：

| 名称 | 内容 |
| --- | --- |
| `app` | 已启动的应用 |
| `config`、`inject`、`useApp` | `@hazejs/core` 中的同名函数 |
| `Cache`、`Queue`、`Events`、`Storage`、`Mail` | 各个门面 |
| `Db` | 数据库门面，安装了 `@hazejs/orm` 时提供 |
| 你的模型 | `app/model/**/*.ts` 导出的每个类，以导出名命名 |

- 支持顶层 `await`。
- 模型记录打印为字段（包括 `hidden` 字段在内的全部字段）和已加载的关联。
- 历史记录保存在 `.haze/repl_history`。
- 修改源码后应用会像 `haze dev` 中一样重新加载，上面这些变量也会随之更新；也可以输入 `.reload` 手动重新加载。
- 输入 `.exit` 或按 Ctrl+D 退出，同时释放应用。

### 执行一段代码

`--eval`（`-e`）不进入交互界面，执行代码、打印结果后直接退出，适合在脚本和测试中使用：

```bash
npx haze repl --eval "await User.count()"
npx haze repl -e "const user = await User.findOrFail(1)
return user.email"
```

单个表达式会打印它的值。包含多条语句的代码会作为异步函数的函数体执行，需要输出结果时用 `return`。代码抛出异常时会打印错误，退出码为 1。
