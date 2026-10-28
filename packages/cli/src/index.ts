import { createRequire } from 'node:module'
import process from 'node:process'
import { defineCommand, runMain, showUsage } from 'citty'
import { loadUserCommands } from './commands/console'
import { generateCommand, migrateCommand, seedCommand } from './commands/db'
import { makeAuthTablesCommand, makeCommands, makeModelCommand, makeNotificationsTableCommand } from './commands/make'
import { searchFlushCommand, searchImportCommand, searchSyncSettingsCommand } from './commands/search'
import { queueFailedCommand, queueFlushCommand, queueForgetCommand, queueRetryCommand, queueWorkCommand, scheduleListCommand, scheduleRunCommand, scheduleWorkCommand } from './commands/worker'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const builtin = {
  'dev': () => import('./commands/dev').then(m => m.default),
  'build': () => import('./commands/build').then(m => m.default),
  'start': () => import('./commands/start').then(m => m.default),
  'preview': () => import('./commands/preview').then(m => m.default),
  'key:generate': () => import('./commands/key').then(m => m.default),
  'test': () => import('./commands/test').then(m => m.default),
  'route:list': () => import('./commands/routes').then(m => m.default),
  'typegen': () => import('./commands/typegen').then(m => m.default),
  'stub:publish': () => import('./commands/stub-publish').then(m => m.default),
  'repl': () => import('./commands/repl').then(m => m.default),
  'openapi': () => import('./commands/openapi').then(m => m.default),
  'microservice:listen': () => import('./commands/microservice').then(m => m.default),
  ...makeCommands,
  'make:model': makeModelCommand,
  'make:notifications-table': makeNotificationsTableCommand,
  'make:auth-tables': makeAuthTablesCommand,
  'db:generate': generateCommand,
  'db:migrate': migrateCommand,
  'db:seed': seedCommand,
  'queue:work': queueWorkCommand,
  'queue:failed': queueFailedCommand,
  'queue:retry': queueRetryCommand,
  'queue:forget': queueForgetCommand,
  'queue:flush': queueFlushCommand,
  'schedule:list': scheduleListCommand,
  'schedule:run': scheduleRunCommand,
  'schedule:work': scheduleWorkCommand,
  'search:import': searchImportCommand,
  'search:flush': searchFlushCommand,
  'search:sync-settings': searchSyncSettingsCommand,
}

// app/command 下的自定义命令（只在运行自定义命令或打印命令列表时加载）
const argv = process.argv.slice(2)
const user = await loadUserCommands(argv, new Set(Object.keys(builtin)))

const main = defineCommand({
  meta: {
    name: 'hazejs',
    version,
    description: 'hazejs Node 服务端框架命令行',
  },
  subCommands: {
    ...builtin,
    ...user.commands,
  },
})

await runMain(main, {
  rawArgs: argv,
  // 打印帮助后 citty 会直接退出进程：先释放应用
  async showUsage(cmd, parent) {
    await showUsage(cmd, parent)
    await user.close()
  },
})
await user.close()
if (Object.keys(user.commands).length) {
  // 命令结束后仍有未关闭的句柄（如命令自己创建的连接）时，不让进程挂起
  setTimeout(() => process.exit(), 2000).unref()
}
