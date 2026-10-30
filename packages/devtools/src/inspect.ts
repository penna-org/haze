import type { Application, RouteInfo } from '@hazejs/core'
import process from 'node:process'

/** 应用概况 */
export interface AppInfo {
  name: string
  mode: string
  debug: boolean
  url: string | undefined
  rootDir: string
  srcDir: string
  node: string
}

export interface ModuleInfo {
  name: string
  source: 'package' | 'local'
  prefix: string
  as: string
  app: string | undefined
  connection: string | undefined
  migrations: string | undefined
  routes: number
}

export interface SubAppInfo {
  name: string
  prefix: string | undefined
  domain: string | undefined
  routes: number
}

export interface RouteRow {
  method: string
  path: string
  name: string
  handler: string
  middleware: string
  module: string
  app: string
}

/** 开发面板（/__haze）的位置；未开启时为 undefined */
export interface DashboardInfo {
  path: string
}

/** 一次重载后的应用快照：只含可序列化数据，供各面板渲染 */
export interface AppSnapshot {
  app: AppInfo
  modules: ModuleInfo[]
  apps: SubAppInfo[]
  routes: RouteRow[]
  dashboard: DashboardInfo | undefined
}

/**
 * 读取应用的结构信息。
 * 应用运行在 Vite ModuleRunner 中（有自己的一份 @hazejs/core），这里只调用实例方法与读取配置，
 * 不依赖类的身份（不能 `app.make(SomeClass)`）。
 */
export function inspectApp(app: Application): AppSnapshot {
  const routes = app.router.list()
  const count = (match: (route: RouteInfo) => boolean): number => routes.filter(match).length

  const modules = app.modules().map((module): ModuleInfo => ({
    name: module.name,
    source: module.source,
    prefix: module.prefix,
    as: module.as,
    app: module.app,
    connection: module.connection,
    migrations: module.migrations,
    routes: count(route => route.module === module.name),
  }))

  const declared = app.config.get<Record<string, { prefix?: string, domain?: string | string[] }>>('app.apps', {})
  const apps = Object.entries(declared).map(([name, config]): SubAppInfo => ({
    name,
    prefix: config.prefix,
    domain: [config.domain ?? []].flat().join(', ') || undefined,
    routes: count(route => route.app === name),
  }))

  return {
    app: {
      name: app.config.get<string>('app.name', 'hazejs'),
      mode: app.mode,
      debug: app.config.get<boolean>('app.debug', false),
      url: app.config.get<string | undefined>('app.url', undefined),
      rootDir: app.rootDir,
      srcDir: app.srcDir,
      node: process.version,
    },
    modules,
    apps,
    routes: routes.map(toRouteRow),
    dashboard: dashboardOf(app),
  }
}

function toRouteRow(route: RouteInfo): RouteRow {
  return {
    method: route.method,
    path: route.domain
      ? `${route.domain}${route.path}`
      : route.path,
    name: route.name ?? '',
    handler: route.handler,
    middleware: route.middleware.join(', '),
    module: route.module ?? '',
    app: route.app ?? '',
  }
}

/** 与 core 的 resolveDashboardConfig 保持一致：只在 development 模式开启 */
function dashboardOf(app: Application): DashboardInfo | undefined {
  const config = app.config.get<{ enabled?: boolean, path?: string }>('observability.dashboard', {})
  if (app.mode !== 'development' || config.enabled === false)
    return undefined
  return { path: `/${(config.path ?? '/__haze').replace(/^\/+|\/+$/g, '')}` }
}

/** 按关键字过滤路由（方法、路径、名称、处理器、中间件、模块、应用任一包含即可） */
export function filterRoutes(routes: readonly RouteRow[], query: string): RouteRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length)
    return [...routes]
  return routes.filter((route) => {
    const text = Object.values(route).join(' ').toLowerCase()
    return words.every(word => text.includes(word))
  })
}
