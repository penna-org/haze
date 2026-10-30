import type { FinalizeContext, Layout, Preset, PresetContext, PresetName } from './types'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { normalizePath } from 'vite'
import { VIRTUAL_MODULES } from '../constants'
import { EDGE_UNSUPPORTED_DRIVERS, writeRuntimePackageJson } from './deps'
import { PRESET_NAMES } from './types'

export { bundleAllExcept, DRIVER_PACKAGES, EDGE_UNSUPPORTED_DRIVERS, externalPackages, externalPattern, findInstalled, scanExternals, traceDependencies } from './deps'
export type { ExternalsOptions, TraceResult } from './deps'
export { PRESET_NAMES } from './types'
export type { CloudflareOptions, FinalizeContext, Layout, Preset, PresetContext, PresetName, VercelOptions } from './types'

const header = `import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createApp } from '${VIRTUAL_MODULES.app}'
`

function staticOption(context: PresetContext, layout: Layout): string {
  if (!context.fullstack || !layout.staticFromServer)
    return ''
  return `static: { dir: fileURLToPath(new URL(${JSON.stringify(layout.staticFromServer)}, import.meta.url)), spaFallback: true, exclude: ${JSON.stringify(context.prefixes)} },`
}

/** 常驻进程：监听端口 */
function listenEntry(context: PresetContext & { layout: Layout }): string {
  return `${header}
const app = await createApp({ mode: 'production', ${staticOption(context, context.layout)} })
app.serve({
  port: Number(process.env.PORT) || ${context.port},
  hostname: process.env.HOST || ${JSON.stringify(context.host ?? '0.0.0.0')},
})
`
}

/** 按需创建应用（Serverless / Edge 冷启动时） */
function lazyApp(context: PresetContext & { layout: Layout }, extra = ''): string {
  return `${header}
let app
function getApp() {
  return (app ??= createApp({ mode: 'production', ${staticOption(context, context.layout)} ${extra} }))
}
void process
void fileURLToPath
`
}

/**
 * 生产迁移脚本（migrate.mjs）：迁移文件已打包进产物，不需要源码与开发工具链。
 * `node migrate.mjs [--connection <name>] [--all]`
 */
export function migrateEntryCode(): string {
  return `import process from 'node:process'
import { parseArgs } from 'node:util'
import { runMigrations } from '@hazejs/orm'
import { createApp } from '${VIRTUAL_MODULES.app}'
import { files } from '${VIRTUAL_MODULES.migrations}'

const { values } = parseArgs({
  options: {
    connection: { type: 'string', short: 'c' },
    all: { type: 'boolean', default: false },
  },
})
const app = await createApp({ mode: 'production' })
try {
  for (const result of await runMigrations({ files, connection: values.connection, all: values.all })) {
    // 没有迁移的目录（如没有 database/migrations 的本地模块）不输出
    if (result.skipped === 'no-migrations')
      continue
    app.logger.info(result.skipped
      ? \`[\${result.connection}] skipped (\${result.skipped})\`
      : \`[\${result.connection}] \${result.applied} of \${result.total} migrations applied (\${result.folder})\`)
  }
}
catch (error) {
  app.logger.error('Migration failed', error)
  process.exitCode = 1
}
finally {
  await app.dispose()
}
`
}

function serverLayout(context: PresetContext, dir = 'server'): Layout {
  return {
    serverDir: join(context.outDir, dir),
    clientDir: context.fullstack
      ? join(context.outDir, 'client')
      : undefined,
    staticFromServer: '../client',
  }
}

function packageName(root: string): string {
  const file = join(root, 'package.json')
  const name = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name
    : undefined
  return (name ?? 'hazejs-app').replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

const rel = (context: FinalizeContext, path: string): string => normalizePath(relative(context.root, path)) || '.'

/**
 * 队列 worker、定时任务与自定义命令（worker.mjs）：
 * `node worker.mjs queue [--queue a,b] [--concurrency 5] [--connection redis]`、
 * `node worker.mjs schedule`（常驻）、`node worker.mjs schedule:run`（执行一次到期任务）、
 * `node worker.mjs command <name> [args]`（app/command 与模块的命令，不带名称时列出全部）
 */
export function workerEntryCode(): string {
  return `import process from 'node:process'
import { parseArgs } from 'node:util'
import { QueueManager, runConsole, runMaintenanceCommand, Scheduler } from '@hazejs/core'
import { createApp } from '${VIRTUAL_MODULES.app}'

// 自定义命令的参数由命令自己的定义解析，不经过下面的 parseArgs
if (process.argv[2] === 'command') {
  const app = await createApp({ mode: 'production' })
  let code = 1
  try {
    // app/command 与已启用模块的命令
    code = await runConsole(app, await app.commands(), process.argv.slice(3))
  }
  catch (error) {
    app.logger.error(error)
  }
  await app.dispose()
  // 管道输出在 macOS 上是异步的：先等缓冲写完再退出
  await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write('', resolve))))
  process.exit(code)
}

// 维护模式：down [--secret ...] / up / maintenance:status（参数由 core 解析）
if (['down', 'up', 'maintenance:status'].includes(process.argv[2])) {
  const app = await createApp({ mode: 'production' })
  let code = 1
  try {
    code = await runMaintenanceCommand(app, process.argv.slice(2))
  }
  catch (error) {
    app.logger.error(error)
  }
  await app.dispose()
  await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write('', resolve))))
  process.exit(code)
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    queue: { type: 'string', short: 'q' },
    concurrency: { type: 'string', short: 'c' },
    connection: { type: 'string' },
  },
})
const command = positionals[0] ?? 'queue'
const app = await createApp({ mode: 'production' })
const controller = new AbortController()
let stopQueue
const shutdown = async () => {
  controller.abort()
  // 等待执行中的任务完成
  await stopQueue?.()
  await app.dispose()
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

if (command === 'queue') {
  const queues = values.queue?.split(',').map(name => name.trim()).filter(Boolean) ?? ['default']
  const worker = await app.make(QueueManager).work({ connection: values.connection, queues, concurrency: Number(values.concurrency ?? 1) })
  stopQueue = worker.stop
  app.logger.info(\`Queue worker started: \${queues.join(', ')}\`)
}
else if (command === 'schedule') {
  app.logger.info(\`Scheduler started: \${app.make(Scheduler).tasks().length} task(s)\`)
  await app.make(Scheduler).work(controller.signal)
}
else if (command === 'schedule:run') {
  const runs = await app.make(Scheduler).runDue()
  await app.dispose()
  process.exit(runs.some(run => run.status === 'failed') ? 1 : 0)
}
else {
  app.logger.error(\`Unknown command "\${command}" (queue | schedule | schedule:run | command | down | up | maintenance:status)\`)
  await app.dispose()
  process.exit(1)
}
`
}

function workerHint(context: FinalizeContext, command: string): string {
  const worker = rel(context, join(context.layout.serverDir, 'worker.mjs'))
  return `\nQueue worker: ${command} ${worker} queue${context.schedules
    ? `\nScheduler: ${command} ${worker} schedule`
    : ''}`
}

function migrateHint(context: FinalizeContext, command: string): string {
  return context.orm
    ? `\nMigrate: ${command} ${rel(context, join(context.layout.serverDir, 'migrate.mjs'))}`
    : ''
}

export const presets: Record<PresetName, Preset> = {
  'node': {
    name: 'node',
    // 与 Nitro 一致：能打包的都打包，驱动与原生模块追踪进产物的 node_modules，dist 可整体拷走运行
    bundle: 'drivers-external',
    trace: 'default',
    // 纯后端沿用 dist/index.mjs，全栈为 dist/server + dist/client
    layout: context => context.fullstack
      ? serverLayout(context)
      : { serverDir: context.outDir, clientDir: undefined, staticFromServer: undefined },
    migrateScript: true,
    entry: listenEntry,
    hint: context => `Run: node ${rel(context, join(context.layout.serverDir, 'index.mjs'))}  (or haze start)${migrateHint(context, 'node')}${workerHint(context, 'node')}`,
  },

  'bun': {
    name: 'bun',
    bundle: 'drivers-external',
    trace: 'default',
    conditions: ['bun', 'module', 'node', 'production'],
    layout: context => context.fullstack
      ? serverLayout(context)
      : { serverDir: context.outDir, clientDir: undefined, staticFromServer: undefined },
    migrateScript: true,
    entry: listenEntry,
    hint: context => `Run: bun ${rel(context, join(context.layout.serverDir, 'index.mjs'))}${migrateHint(context, 'bun')}${workerHint(context, 'bun')}`,
  },

  'deno': {
    name: 'deno',
    bundle: 'drivers-external',
    trace: 'default',
    conditions: ['deno', 'module', 'node', 'production'],
    layout: serverLayout,
    migrateScript: true,
    entry: listenEntry,
    hint: context => `Run: deno run -A ${rel(context, join(context.layout.serverDir, 'index.mjs'))}${migrateHint(context, 'deno run -A')}${workerHint(context, 'deno run -A')}`,
  },

  'docker': {
    name: 'docker',
    bundle: 'drivers-external',
    layout: serverLayout,
    migrateScript: true,
    entry: listenEntry,
    async finalize(context) {
      // 框架与纯 JS 依赖已打包；数据库驱动等在容器内安装（得到 Linux 平台的原生二进制）
      await writeRuntimePackageJson(join(context.outDir, 'package.json'), context.root, context.externals)
      await writeFile(join(context.outDir, 'Dockerfile'), `# 由 haze build --preset docker 生成
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${context.port}
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE ${context.port}
# 存活检查：/health/live（config/health.ts 修改了 path 或关闭健康检查时请同步调整）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||${context.port})+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
`)
      await writeFile(join(context.outDir, '.dockerignore'), 'node_modules\nDockerfile\n.dockerignore\n')
    },
    hint: context => `Build image: docker build -t ${packageName(context.root)} ${rel(context, context.outDir)}\nRun: docker run -p ${context.port}:${context.port} -e APP_KEY=<key> ${packageName(context.root)}${context.orm
      ? `\nMigrate: docker run --rm ${packageName(context.root)} node server/migrate.mjs`
      : ''}\nQueue worker: docker run ${packageName(context.root)} node server/worker.mjs queue${context.schedules
      ? `\nScheduler: docker run ${packageName(context.root)} node server/worker.mjs schedule`
      : ''}`,
  },

  'aws-lambda': {
    name: 'aws-lambda',
    bundle: 'drivers-external',
    trace: 'always',
    runtimePlatform: 'linux',
    layout: context => ({
      serverDir: join(context.outDir, 'lambda'),
      clientDir: context.fullstack
        ? join(context.outDir, 'lambda', 'client')
        : undefined,
      staticFromServer: './client',
    }),
    entry: context => `${lazyApp(context)}
import { createLambdaHandler } from '@hazejs/core'

/** API Gateway（HTTP API / REST API）、ALB、Function URL 事件 */
export const handler = createLambdaHandler(async () => (await getApp()).fetch)

import { Scheduler } from '@hazejs/core'

/** 定时任务：handler 设为 index.schedule，由 EventBridge 每分钟触发（rate(1 minute)） */
export async function schedule(event = {}) {
  const runs = await (await getApp()).make(Scheduler).runDue(event.time ? new Date(event.time) : new Date())
  return runs.map(({ name, status, reason }) => ({ name, status, reason }))
}
${context.orm
  ? `
import { runMigrations } from '@hazejs/orm'
import { files } from '${VIRTUAL_MODULES.migrations}'

/** 生产迁移：handler 设为 index.migrate 的函数（或直接调用），事件 { connection?, all? } */
export async function migrate(event = {}) {
  await getApp()
  return runMigrations({ files, connection: event.connection, all: event.all })
}
`
  : ''}`,
    async finalize(context) {
      const dir = context.layout.serverDir
      await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
    },
    hint: context => `Zip ${rel(context, context.layout.serverDir)} and set the Lambda handler to index.handler (runtime nodejs22.x), with APP_KEY in the environment${context.orm
      ? '\nMigrate: invoke the same bundle with handler index.migrate (event: { "connection"?: string, "all"?: boolean })'
      : ''}${context.schedules
      ? '\nScheduler: a function with handler index.schedule, triggered by an EventBridge rule rate(1 minute)'
      : ''}`,
  },

  'vercel': {
    name: 'vercel',
    bundle: 'drivers-external',
    trace: 'always',
    runtimePlatform: 'linux',
    layout: context => ({
      serverDir: join(context.root, '.vercel', 'output', 'functions', '__server.func'),
      clientDir: join(context.root, '.vercel', 'output', 'static'),
      staticFromServer: undefined,
    }),
    entry: context => `${lazyApp(context)}
import { Scheduler, toNodeHandler } from '@hazejs/core'

let handler
export default async function vercelHandler(req, res) {
  // Vercel Cron：调用 /__haze/schedule，并带上 Authorization: Bearer $CRON_SECRET
  if (req.url?.split('?')[0] === '/__haze/schedule') {
    if (!process.env.CRON_SECRET || req.headers.authorization !== \`Bearer \${process.env.CRON_SECRET}\`) {
      res.statusCode = 401
      return res.end('Unauthorized')
    }
    const runs = await (await getApp()).make(Scheduler).runDue()
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify(runs.map(({ name, status, reason }) => ({ name, status, reason }))))
  }
  handler ??= toNodeHandler((await getApp()).h3)
  return handler(req, res)
}
`,
    async finalize(context) {
      const output = join(context.root, '.vercel', 'output')
      const dir = context.layout.serverDir
      await mkdir(join(output, 'static'), { recursive: true })
      await writeFile(join(dir, '.vc-config.json'), `${JSON.stringify({
        runtime: 'nodejs22.x',
        handler: 'index.mjs',
        launcherType: 'Nodejs',
        shouldAddSourcemapSupport: true,
        supportsResponseStreaming: true,
      }, null, 2)}\n`)
      await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
      // 静态文件优先，其余交给函数；全栈时非后端路径回退到 index.html（前端路由）
      const cron = context.schedules
        ? [
            { src: '^/__haze/schedule$', dest: '/__server' },
          ]
        : []
      const routes = context.fullstack
        ? [
            { handle: 'filesystem' },
            ...cron,
            ...context.prefixes.map(prefix => ({ src: `^${prefix}(?:/.*)?$`, dest: '/__server' })),
            { src: '/(.*)', dest: '/index.html' },
          ]
        : [
            { handle: 'filesystem' },
            { src: '/(.*)', dest: '/__server' },
          ]
      const crons = context.schedules
        ? [
            { path: '/__haze/schedule', schedule: context.vercel?.cron ?? '* * * * *' },
          ]
        : undefined
      await writeFile(join(output, 'config.json'), `${JSON.stringify({
        version: 3,
        routes,
        ...(crons && { crons }),
      }, null, 2)}\n`)
    },
    hint: context => `Deploy the prebuilt output: vercel deploy --prebuilt (set APP_KEY with: vercel env add APP_KEY)${context.schedules
      ? '\nScheduler: Vercel Cron calls /__haze/schedule; set CRON_SECRET (vercel env add CRON_SECRET). Hobby plans only allow daily crons (haze.config.ts: vercel.cron)'
      : ''}`,
  },

  'netlify': {
    name: 'netlify',
    bundle: 'drivers-external',
    layout: context => ({
      ...serverLayout(context),
      staticFromServer: undefined,
    }),
    entry: context => `${lazyApp(context)}
/** Netlify Functions（v2）：Web Request → Response */
export default async function netlifyHandler(request) {
  return (await getApp()).fetch(request)
}
`,
    async finalize(context) {
      const functions = join(context.root, '.netlify', 'v1', 'functions')
      await mkdir(functions, { recursive: true })
      const entry = normalizePath(relative(functions, join(context.layout.serverDir, 'index.mjs')))
      const paths = context.fullstack
        ? context.prefixes.flatMap(prefix => [prefix, `${prefix}/*`])
        : ['/*']
      // config 必须是字面量（Netlify 静态解析）
      await writeFile(join(functions, 'haze-server.mjs'), `// 由 haze build --preset netlify 生成
export { default } from '${entry.startsWith('.')
  ? entry
  : `./${entry}`}'

export const config = {
  name: 'hazejs server',
  generator: 'hazejs',
  path: ${JSON.stringify(paths)},
  preferStatic: true,
}
`)
      const publish = context.layout.clientDir ?? join(context.outDir, 'public')
      await mkdir(publish, { recursive: true })
      if (context.fullstack)
        await writeFile(join(publish, '_redirects'), '/*  /index.html  200\n')
      const toml = join(context.root, 'netlify.toml')
      if (!existsSync(toml))
        await writeFile(toml, `[build]\n  command = "npx haze build --preset netlify"\n  publish = "${rel(context, publish)}"\n`)
    },
    hint: context => `${existsSync(join(context.root, 'netlify.toml'))
      ? 'Deploy with: netlify deploy --build (publish directory is set in netlify.toml)'
      : 'Deploy with: netlify deploy --build'}\nSet APP_KEY with: netlify env:set APP_KEY <key>`,
  },

  'cloudflare': {
    name: 'cloudflare',
    bundle: 'all',
    // 与 wrangler 一致：workerd 优先，其次 browser（如 consola 的浏览器构建不依赖 node:tty）
    conditions: [
      'workerd',
      'worker',
      'browser',
      'module',
      'production',
    ],
    // 同 wrangler：优先 browser 字段（如 AWS SDK 的 runtimeConfig.browser 使用 fetch，不依赖 node:child_process）
    mainFields: [
      'browser',
      'module',
      'jsnext:main',
      'jsnext',
      'main',
    ],
    target: 'es2022',
    platform: 'browser',
    singleFile: true,
    // D1 与 libsql（Web 版 / turso 驱动）、postgres.js（cloudflare:sockets）可在 Workers 运行；其余驱动替换为报错空模块
    unsupported: EDGE_UNSUPPORTED_DRIVERS,
    external: [/^cloudflare:/],
    layout: context => ({
      serverDir: context.outDir,
      clientDir: context.fullstack
        ? join(context.outDir, 'client')
        : undefined,
      staticFromServer: undefined,
    }),
    entry: context => `${lazyApp(context, `env: false,`)}
import { QueueManager, Scheduler, setPlatformBindings } from '@hazejs/core'
${context.websocket
  ? `import { createWebSocketDurableObject } from '@hazejs/core/cloudflare'

// WebSocket：所有连接在同一个 Durable Object 中，订阅 / 广播全局生效；钩子在 DO 内经应用解析（含中间件）
const websocket = createWebSocketDurableObject({ fetch: async request => (await getApp()).fetch(request), bind: env => bind(env) })
export const HazeWebSocket = websocket.HazeWebSocket
`
  : ''}
function bind(env) {
  setPlatformBindings(env)
  if (!app) {
    for (const [key, value] of Object.entries(env ?? {})) {
      if (typeof value === 'string' && process.env[key] === undefined)
        process.env[key] = value
    }
  }
}

/** Cloudflare Workers：静态资源由 Workers Assets 提供，环境变量与 D1 等来自绑定 */
export default {
  async fetch(request, env, ctx) {
    bind(env)
${context.websocket
  ? `    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket')
      return websocket.handleUpgrade(request, env, ctx)
`
  : ''}    return (await getApp()).fetch(request)
  },
  /** Cloudflare Queues 消费：重试映射为 message.retry({ delaySeconds }) */
  async queue(batch, env) {
    bind(env)
    await (await getApp()).make(QueueManager).handleBatch(batch)
  },
  /** Cron Triggers：执行该分钟到期的定时任务 */
  async scheduled(controller, env, ctx) {
    bind(env)
    ctx.waitUntil((async () => (await getApp()).make(Scheduler).runDue(new Date(controller.scheduledTime)))())
  },
}
`,
    async finalize(context) {
      const { compatibility_flags: flags, assets, d1_databases: d1, ...user } = (context.cloudflare?.wrangler ?? {}) as {
        compatibility_flags?: string[]
        assets?: Record<string, unknown>
        d1_databases?: Record<string, unknown>[]
      }
      const config: Record<string, unknown> = {
        name: packageName(context.root),
        main: 'index.mjs',
        compatibility_date: '2026-01-01',
        ...user,
        compatibility_flags: [
          ...new Set([
            'nodejs_compat',
            ...(flags ?? []),
          ]),
        ],
      }
      if (context.fullstack || assets) {
        config.assets = {
          ...(context.fullstack && {
            directory: './client',
            not_found_handling: 'single-page-application',
            run_worker_first: context.prefixes.map(prefix => `${prefix}/*`),
          }),
          ...assets,
        }
      }
      if (d1?.length) {
        // wrangler d1 migrations apply 读取 drizzle-kit 生成的 SQL（默认连接在 migrations/，其它连接在 migrations/<name>/）
        config.d1_databases = d1.map(database => ({ migrations_dir: 'migrations', ...database }))
        const source = join(context.srcDir, 'database', 'migrations')
        if (existsSync(source))
          await cp(source, join(context.outDir, 'migrations'), { recursive: true })
      }
      // WebSocket：Durable Object 绑定与迁移（SQLite 存储的 DO，免费计划可用）
      if (context.websocket) {
        const durable = (config.durable_objects ?? {}) as { bindings?: unknown[] }
        config.durable_objects = {
          ...durable,
          bindings: [
            ...(durable.bindings ?? []),
            { name: 'HAZE_WEBSOCKET', class_name: 'HazeWebSocket' },
          ],
        }
        config.migrations = [
          ...((config.migrations ?? []) as unknown[]),
          {
            tag: 'haze-websocket-v1',
            new_sqlite_classes: ['HazeWebSocket'],
          },
        ]
      }
      // 定时任务：每分钟触发 scheduled()，由框架判断哪些任务到期
      if (context.schedules && !config.triggers) {
        config.triggers = {
          crons: ['* * * * *'],
        }
      }
      await writeFile(join(context.outDir, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`)
    },
    hint: (context) => {
      const wrangler = rel(context, join(context.outDir, 'wrangler.json'))
      const d1 = ((context.cloudflare?.wrangler?.d1_databases ?? []) as { database_name?: string, binding?: string }[])
        .map(database => `\nApply D1 migrations: npx wrangler d1 migrations apply ${database.database_name ?? database.binding} --remote -c ${wrangler}`)
      // Workers 没有 .env：APP_KEY 等密钥以 secret 绑定提供
      return `Deploy: npx wrangler deploy -c ${wrangler}\nSecrets: npx wrangler secret put APP_KEY -c ${wrangler}${d1.join('')}`
    },
  },
}

export function resolvePreset(name: string | undefined): Preset {
  const preset = presets[(name ?? 'node') as PresetName]
  if (!preset)
    throw new Error(`Unknown preset "${name}". Available: ${PRESET_NAMES.join(', ')}`)
  return preset
}
