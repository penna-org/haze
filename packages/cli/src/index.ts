import { createRequire } from 'node:module'
import { defineCommand, runMain } from 'citty'

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
    'test': () => import('./commands/test').then(m => m.default),
    'route:list': () => import('./commands/routes').then(m => m.default),
  },
})

runMain(main)
