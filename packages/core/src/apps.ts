import type { ConfigInput } from './config/config'
import type { ExceptionHandler } from './exception/handler'
import type { ResponseFormatter } from './http/formatter'
import type { ProviderInput } from './provider'
import type { RouteModule } from './routing/builder'
import type { Constructor, ModuleRecord } from './utils'
import { unwrapDefault } from './utils'

/** `config/app.ts` 中 `apps` 的每一项 */
export interface SubAppConfig {
  /** URL 前缀，例如 `/admin`；`/` 表示兜底应用 */
  prefix?: string
  /** 绑定域名，支持 `*.example.com` 通配 */
  domain?: string | string[]
}

/** 从 `app/<name>/` 目录发现的模块 */
export interface SubAppModules {
  routes: RouteModule[]
  /** [配置名, 配置值] */
  config: Array<[string, ConfigInput<Record<string, any>>]>
  providers: ProviderInput[]
  exceptionHandler?: Constructor<ExceptionHandler>
  responseFormatter?: Constructor<ResponseFormatter>
}

const APP_MODULE_RE = /\/app\/([^/]+)\/(route|config|provider|exception|response)\/([^/]+)\.[cm]?[jt]s$/

/** 按应用分组 `import.meta.glob('/app/*\/{route,config,...}/*')` 的结果 */
export function groupAppModules(record: ModuleRecord | undefined): Map<string, SubAppModules> {
  const apps = new Map<string, SubAppModules>()
  for (const [path, mod] of Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const match = APP_MODULE_RE.exec(path)
    if (!match)
      continue
    const [, name, kind, file] = match
    let app = apps.get(name)
    if (!app) {
      app = { routes: [], config: [], providers: [] }
      apps.set(name, app)
    }
    const value = unwrapDefault<any>(mod)
    switch (kind) {
      case 'route':
        app.routes.push(value)
        break
      case 'config':
        app.config.push([file, value])
        break
      case 'provider':
        app.providers.push(value)
        break
      case 'exception':
        if (file === 'Handler')
          app.exceptionHandler = value
        break
      case 'response':
        if (file === 'Formatter')
          app.responseFormatter = value
        break
    }
  }
  return apps
}

export interface AppMatcher {
  name: string
  prefix: string
  domains: string[]
}

export function normalizeAppConfig(name: string, config: SubAppConfig): AppMatcher {
  const domains = config.domain === undefined
    ? []
    : Array.isArray(config.domain)
      ? config.domain
      : [config.domain]
  if (config.prefix === undefined && !domains.length)
    throw new Error(`App "${name}" needs a prefix or a domain in config/app.ts (apps.${name})`)
  const prefix = `/${(config.prefix ?? '/').replace(/^\/+|\/+$/g, '')}`
  return {
    name,
    prefix,
    domains: domains.map(domain => domain.toLowerCase()),
  }
}

/** 绑定域名的应用优先，其次前缀更长的应用 */
export function matchApp<T extends AppMatcher>(apps: readonly T[], host: string, path: string): T | undefined {
  let best: T | undefined
  let bestScore = -1
  for (const app of apps) {
    if (app.domains.length && !app.domains.some(domain => matchDomain(domain, host)))
      continue
    if (!matchPrefix(app.prefix, path))
      continue
    const score = (app.domains.length ? 100_000 : 0) + app.prefix.length
    if (score > bestScore) {
      best = app
      bestScore = score
    }
  }
  return best
}

export function matchPrefix(prefix: string, path: string): boolean {
  return prefix === '/' || path === prefix || path.startsWith(`${prefix}/`)
}

export function matchDomain(pattern: string, host: string): boolean {
  const hostname = host.toLowerCase()
  if (pattern.startsWith('*.'))
    return hostname.endsWith(pattern.slice(1)) && hostname.length > pattern.length - 1
  return hostname === pattern
}

/** 启动时检查冲突：同样的域名 + 前缀只能属于一个应用 */
export function assertNoConflicts(apps: readonly AppMatcher[]): void {
  const seen = new Map<string, string>()
  for (const app of apps) {
    for (const domain of app.domains.length
      ? app.domains
      : ['*']) {
      const key = `${domain}${app.prefix}`
      const other = seen.get(key)
      if (other) {
        throw new Error(`Apps "${other}" and "${app.name}" both handle ${domain === '*'
          ? ''
          : domain}${app.prefix}`)
      }
      seen.set(key, app.name)
    }
  }
}
