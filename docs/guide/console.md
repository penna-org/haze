# Console Commands

Besides the built-in `haze` commands, you can write your own: data fixes, reports, imports, maintenance tasks. A command is a file in `app/command` that default-exports `defineCommand()`. It runs with the application booted, so models, facades and the container work exactly as in a request. The same command runs from source with `haze <name>` and from the build output with `node dist/worker.mjs command <name>`.

`haze repl` opens an interactive shell with the booted application, the facades and your models.

::: tip Directory convention
The examples use the API template layout (`app/...`). In full-stack projects these directories live under `server/`.
:::

## Defining commands

Generate a command:

```bash
npx haze make:command SendReport
```

```ts
// app/command/SendReport.ts
import { defineCommand, Mail } from '@hazejs/core'
import ReportMail from '~/app/mail/ReportMail'
import { User } from '~/app/model/User'

export default defineCommand({
  description: 'Email the daily report',
  args: {
    to: { type: 'positional', description: 'Recipient' },
    format: { type: 'enum', options: ['html', 'text'], default: 'html' },
    dryRun: { type: 'boolean', alias: 'd', description: 'Print instead of sending' },
  },
  async run(args, ctx) {
    const users = await User.count()
    if (args.dryRun) {
      ctx.logger.info(`${users} users, would send to ${args.to}`)
      return
    }
    await Mail.to(args.to).send(ReportMail, { users })
    ctx.logger.success(`Report sent to ${args.to}`)
  },
})
```

```bash
npx haze send:report ops@example.com --dry-run
npx haze send:report --help
```

Commands are discovered automatically, including subdirectories. Modules in `app/command` whose default export is not a command (shared helpers, for example) are ignored.

## Command names

The name comes from the file path unless `name` is set:

| File | Command |
| --- | --- |
| `app/command/Inspire.ts` | `inspire` |
| `app/command/SendReport.ts` | `send:report` |
| `app/command/SendDailyReport.ts` | `send:daily-report` |
| `app/command/db/Cleanup.ts` | `db:cleanup` |
| `app/command/db/PruneOld.ts` | `db:prune-old` |

- Top-level files are grouped by their first word; subdirectories become the group instead.
- A trailing `Command` is dropped: `SendReportCommand.ts` is `send:report`.
- `defineCommand({ name: 'report:send', ... })` overrides the derived name.

Names must be unique. A command whose name matches a built-in command (such as `make:model`) is skipped with a warning.

## Arguments

`args` uses the same definitions as [citty](https://github.com/unjs/citty), the library behind the `haze` CLI, so `haze <name> --help` shows them like any built-in command:

| Type | Example | Parsed as |
| --- | --- | --- |
| `positional` | `haze send:report ops@example.com` | `string`; required unless `required: false` or a `default` is set |
| `string` | `--to ops@example.com`, `--to=ops@example.com` | `string`, or `undefined` when omitted without a `default` |
| `boolean` | `--dry-run`, `-d`, `--no-dry-run` | `boolean` (`false` when omitted) |
| `enum` | `--format text` | one of `options`; any other value is an error |

Each definition accepts `description`, `default`, `alias` (one or more short names, not for positionals), `required` and `valueHint`. Options can be written in camel case or kebab case (`--dryRun` and `--dry-run` both set `dryRun`). Positional arguments are assigned in definition order, and `args._` holds all of them, including extra ones.

The parsed `args` are typed from the definitions: required positionals are `string`, enums are a union of their options, and options without a default may be `undefined`.

A missing required argument or an invalid enum value prints the command's usage and exits with code 1 before `run()` is called.

## Command context

`run(args, ctx)` receives:

| Property | Description |
| --- | --- |
| `ctx.app` | The booted application, for `ctx.app.make(Service)` or `ctx.app.config` |
| `ctx.logger` | The application logger |
| `ctx.name` | The command name |
| `ctx.rawArgs` | The arguments after the command name, unparsed |
| `ctx.confirm(message, initial?)` | Ask a yes / no question, returns `boolean` |
| `ctx.ask(message, { default?, placeholder? })` | Ask for text, returns `string` |
| `ctx.choice(message, options, initial?)` | Pick one of `options`, returns the chosen value |
| `ctx.prompt(message, options)` | The underlying consola `prompt()`, for `multiselect` and other options |

Prompts reject when the user cancels with Ctrl+C, which ends the command with exit code 1. Do not prompt in commands that run unattended (cron, CI); offer a `--force` flag instead.

Inside `run()`, `useApp()`, `config()` and the facades (`Cache`, `Queue`, `Mail`, `Db`, ...) work as they do in a request.

## Exit codes

- `run()` returns nothing: exit code `0`.
- `run()` returns a number: that number is the exit code.
- `run()` throws: the error is logged and the exit code is `1`.

After `run()` finishes, the application is disposed (database connections, queues and mail transports are closed) and the process exits.

## Running commands

### In development

```bash
npx haze --help                     # built-in and your commands
npx haze send:report --help         # usage of one command
npx haze send:report ops@example.com
npx haze send:report ops@example.com --root ./apps/api
```

Like `queue:work`, commands run your TypeScript source in the same Vite module graph as the dev server, without opening a port. `--root` is handled by `haze` and not passed to the command, unless the command defines a `root` argument itself.

The CLI only loads `app/command` when it needs to: when you run one of your commands, or when it prints the command list. Built-in commands do not boot the application for this.

### In production

For the process-based presets (`node`, `bun`, `deno`, `docker`) the build includes your commands in `worker.mjs`. The source and the CLI are not needed:

```bash
node dist/worker.mjs command                          # list commands
node dist/worker.mjs command send:report --help
node dist/worker.mjs command send:report ops@example.com --dry-run
```

Full-stack projects and the `deno` / `docker` presets put `worker.mjs` in `dist/server/`. Arguments are parsed with the same rules as in development, and the process exits with the command's exit code.

Command modules are loaded on demand: the web server (`index.mjs`) does not execute them. Serverless and edge presets have no command entry.

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

The REPL boots the application like `haze dev` (without opening a port) and puts these in scope:

| Name | Value |
| --- | --- |
| `app` | The booted application |
| `config`, `inject`, `useApp` | The helpers from `@hazejs/core` |
| `Cache`, `Queue`, `Events`, `Storage`, `Mail` | The facades |
| `Db` | The database facade, when `@hazejs/orm` is installed |
| Your models | Every class exported from `app/model/**/*.ts`, by its export name |

- Top-level `await` works.
- Model records print as their fields (all of them, including `hidden` ones) and loaded relations.
- History is saved to `.haze/repl_history`.
- Editing source files reloads the application, as in `haze dev`, and the names above are updated. `.reload` reloads by hand.
- `.exit` or Ctrl+D quits and disposes the application.

### Evaluating code

`--eval` (`-e`) runs code without the interactive prompt, prints the result and exits. This is handy in scripts and tests:

```bash
npx haze repl --eval "await User.count()"
npx haze repl -e "const user = await User.findOrFail(1)
return user.email"
```

A single expression prints its value. Code with several statements runs as the body of an async function, so use `return` to print a value. If the code throws, the error is printed and the exit code is 1.
