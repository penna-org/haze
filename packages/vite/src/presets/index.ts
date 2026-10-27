import type { FinalizeContext, Layout, Preset, PresetContext, PresetName } from './types'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { normalizePath } from 'vite'
import { VIRTUAL_MODULES } from '../constants'
import { copyDependencies, EDGE_UNSUPPORTED_DRIVERS, writeRuntimePackageJson } from './deps'
import { PRESET_NAMES } from './types'

export { BUNDLE_ALL_EXCEPT_DRIVERS, copyDependencies, EDGE_UNSUPPORTED_DRIVERS, projectDrivers, scanExternals } from './deps'
export { PRESET_NAMES } from './types'
export type { FinalizeContext, Layout, Preset, PresetContext, PresetName } from './types'

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
  return (name ?? 'think-h3-app').replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}

const rel = (context: FinalizeContext, path: string): string => normalizePath(relative(context.root, path)) || '.'

export const presets: Record<PresetName, Preset> = {
  'node': {
    name: 'node',
    bundle: 'external',
    // 纯后端沿用 dist/index.mjs，全栈为 dist/server + dist/client
    layout: context => context.fullstack
      ? serverLayout(context)
      : { serverDir: context.outDir, clientDir: undefined, staticFromServer: undefined },
    entry: listenEntry,
    hint: context => `Run: node ${rel(context, join(context.layout.serverDir, 'index.mjs'))}  (or think-h3 start)`,
  },

  'bun': {
    name: 'bun',
    bundle: 'external',
    conditions: ['bun', 'module', 'node', 'production'],
    layout: context => context.fullstack
      ? serverLayout(context)
      : { serverDir: context.outDir, clientDir: undefined, staticFromServer: undefined },
    entry: listenEntry,
    hint: context => `Run: bun ${rel(context, join(context.layout.serverDir, 'index.mjs'))}`,
  },

  'deno': {
    name: 'deno',
    bundle: 'drivers-external',
    conditions: ['deno', 'module', 'node', 'production'],
    layout: serverLayout,
    entry: listenEntry,
    hint: context => `Run: deno run -A ${rel(context, join(context.layout.serverDir, 'index.mjs'))}`,
  },

  'docker': {
    name: 'docker',
    bundle: 'drivers-external',
    layout: serverLayout,
    entry: listenEntry,
    async finalize(context) {
      // 框架与纯 JS 依赖已打包；数据库驱动等在容器内安装（得到 Linux 平台的原生二进制）
      await writeRuntimePackageJson(join(context.outDir, 'package.json'), context.root, context.externals)
      await writeFile(join(context.outDir, 'Dockerfile'), `# 由 think-h3 build --preset docker 生成
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${context.port}
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE ${context.port}
CMD ["node", "server/index.mjs"]
`)
      await writeFile(join(context.outDir, '.dockerignore'), 'node_modules\nDockerfile\n.dockerignore\n')
    },
    hint: context => `Build image: docker build -t ${packageName(context.root)} ${rel(context, context.outDir)}\nRun: docker run -p ${context.port}:${context.port} ${packageName(context.root)}`,
  },

  'aws-lambda': {
    name: 'aws-lambda',
    bundle: 'drivers-external',
    layout: context => ({
      serverDir: join(context.outDir, 'lambda'),
      clientDir: context.fullstack
        ? join(context.outDir, 'lambda', 'client')
        : undefined,
      staticFromServer: './client',
    }),
    entry: context => `${lazyApp(context)}
import { createLambdaHandler } from '@think-h3/core'

/** API Gateway（HTTP API / REST API）、ALB、Function URL 事件 */
export const handler = createLambdaHandler(async () => (await getApp()).fetch)
`,
    async finalize(context) {
      const dir = context.layout.serverDir
      await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
      await copyDependencies(context.externals, context.root, join(dir, 'node_modules'))
    },
    hint: context => `Zip ${rel(context, context.layout.serverDir)} and set the Lambda handler to index.handler (runtime nodejs22.x)`,
  },

  'vercel': {
    name: 'vercel',
    bundle: 'drivers-external',
    layout: context => ({
      serverDir: join(context.root, '.vercel', 'output', 'functions', '__server.func'),
      clientDir: join(context.root, '.vercel', 'output', 'static'),
      staticFromServer: undefined,
    }),
    entry: context => `${lazyApp(context)}
import { toNodeHandler } from '@think-h3/core'

let handler
export default async function vercelHandler(req, res) {
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
      await copyDependencies(context.externals, context.root, join(dir, 'node_modules'))
      // 静态文件优先，其余交给函数；全栈时非后端路径回退到 index.html（前端路由）
      const routes = context.fullstack
        ? [
            { handle: 'filesystem' },
            ...context.prefixes.map(prefix => ({ src: `^${prefix}(?:/.*)?$`, dest: '/__server' })),
            { src: '/(.*)', dest: '/index.html' },
          ]
        : [
            { handle: 'filesystem' },
            { src: '/(.*)', dest: '/__server' },
          ]
      await writeFile(join(output, 'config.json'), `${JSON.stringify({ version: 3, routes }, null, 2)}\n`)
    },
    hint: () => 'Deploy the prebuilt output: vercel deploy --prebuilt',
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
      await writeFile(join(functions, 'think-h3-server.mjs'), `// 由 think-h3 build --preset netlify 生成
export { default } from '${entry.startsWith('.')
  ? entry
  : `./${entry}`}'

export const config = {
  name: 'think-h3 server',
  generator: 'think-h3',
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
        await writeFile(toml, `[build]\n  command = "npx think-h3 build --preset netlify"\n  publish = "${rel(context, publish)}"\n`)
    },
    hint: context => existsSync(join(context.root, 'netlify.toml'))
      ? 'Deploy with: netlify deploy --build (publish directory is set in netlify.toml)'
      : 'Deploy with: netlify deploy --build',
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
    target: 'es2022',
    platform: 'browser',
    singleFile: true,
    // libsql（Web 版）与 postgres.js（cloudflare:sockets）可在 Workers 运行；其余驱动替换为报错空模块
    unsupported: EDGE_UNSUPPORTED_DRIVERS,
    layout: context => ({
      serverDir: context.outDir,
      clientDir: context.fullstack
        ? join(context.outDir, 'client')
        : undefined,
      staticFromServer: undefined,
    }),
    entry: context => `${lazyApp(context, `env: false,`)}
/** Cloudflare Workers：静态资源由 Workers Assets 提供，环境变量来自绑定 */
export default {
  async fetch(request, env) {
    if (!app) {
      for (const [key, value] of Object.entries(env ?? {})) {
        if (typeof value === 'string' && process.env[key] === undefined)
          process.env[key] = value
      }
    }
    return (await getApp()).fetch(request)
  },
}
`,
    async finalize(context) {
      const config: Record<string, unknown> = {
        name: packageName(context.root),
        main: 'index.mjs',
        compatibility_date: '2026-01-01',
        compatibility_flags: ['nodejs_compat'],
      }
      if (context.fullstack) {
        config.assets = {
          directory: './client',
          not_found_handling: 'single-page-application',
          run_worker_first: context.prefixes.map(prefix => `${prefix}/*`),
        }
      }
      await writeFile(join(context.outDir, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`)
    },
    hint: context => `Deploy: npx wrangler deploy -c ${rel(context, join(context.outDir, 'wrangler.json'))}`,
  },
}

export function resolvePreset(name: string | undefined): Preset {
  const preset = presets[(name ?? 'node') as PresetName]
  if (!preset)
    throw new Error(`Unknown preset "${name}". Available: ${PRESET_NAMES.join(', ')}`)
  return preset
}
