import { createRequire } from 'node:module'
import { defineCommand, runMain } from 'citty'
import { generateCommand, migrateCommand, seedCommand } from './commands/db'
import { makeCommands, makeModelCommand } from './commands/make'
import { queueFailedCommand, queueFlushCommand, queueForgetCommand, queueRetryCommand, queueWorkCommand, scheduleListCommand, scheduleRunCommand, scheduleWorkCommand } from './commands/worker'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const main = defineCommand({
  meta: {
    name: 'think-h3',
    version,
    description: 'think-h3 Node 服务端框架命令行',
  },
  subCommands: {
    'dev': () => import('./commands/dev').then(m => m.default),
    'build': () => import('./commands/build').then(m => m.default),
    'start': () => import('./commands/start').then(m => m.default),
    'preview': () => import('./commands/preview').then(m => m.default),
    'key:generate': () => import('./commands/key').then(m => m.default),
    'test': () => import('./commands/test').then(m => m.default),
    'route:list': () => import('./commands/routes').then(m => m.default),
    'typegen': () => import('./commands/typegen').then(m => m.default),
    'stub:publish': () => import('./commands/stub-publish').then(m => m.default),
    ...makeCommands,
    'make:model': makeModelCommand,
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
  },
})

runMain(main)
