import type { Application } from './application'
import type { BindingInfo } from './container/container'
import type { MiddlewareRegistry } from './middleware/registry'
import type { ResolvedModule } from './modules'
import type { RouteInfo } from './routing/router'
import type { ScheduleDefinition } from './schedule/schedule'
import process from 'node:process'
import { EventManager } from './events/manager'
import { resolveDashboardConfig } from './observability/observability'
import { resolveOpenAPIConfig } from './openapi/middleware'
import { QueueManager } from './queue/manager'
import { runInApp } from './request'
import { Schedule } from './schedule/schedule'
import { Scheduler } from './schedule/scheduler'

/** 模块或项目提供的一项定义及其来源 */
export interface OwnedItem {
  name: string | undefined
  value: unknown
  /** 所属模块；项目自己的定义为 undefined */
  module: string | undefined
}

/** Application 交给 introspect() 的内部状态 */
export interface IntrospectionInternals {
  owned: (field: 'jobs' | 'schedules' | 'events' | 'listeners') => OwnedItem[]
  providers: ProviderInfo[]
  middleware: MiddlewareRegistry | undefined
  globalMiddleware: string[]
}

export interface ProviderInfo {
  name: string
  module?: string
  /** 来自 app/<name>/provider 的提供者 */
  app?: string
}

export interface ModuleIntrospection {
  name: string
  source: 'package' | 'local'
  prefix: string
  as: string
  app?: string
  connection?: string
  migrations?: string
  routes: number
  providers: string[]
  jobs: string[]
  schedules: string[]
  events: string[]
  listeners: string[]
  middleware: { aliases: string[], groups: string[], global: string[] }
}

export interface EventIntrospection {
  name: string
  module?: string
  listeners: Array<{ name: string, module?: string, queued: boolean }>
}

export interface JobIntrospection {
  name: string
  module?: string
  queue?: string
  connection?: string
  tries?: number
}

export interface ScheduleIntrospection {
  name: string
  module?: string
  kind: 'call' | 'job'
  expression: string
  timezone?: string
  /** ISO 时间，无法计算时为 undefined */
  nextRun?: string
  withoutOverlapping: boolean
  onOneServer: boolean
}

/** `app.introspect()` 的结果：只含可序列化数据（开发工具、`haze about` 等使用） */
export interface AppIntrospection {
  app: {
    name: string
    mode: string
    debug: boolean
    url?: string
    rootDir: string
    srcDir: string
    node: string
  }
  modules: ModuleIntrospection[]
  apps: Array<{ name: string, prefix?: string, domain?: string, routes: number }>
  routes: RouteInfo[]
  middleware: {
    /** 每个请求都会经过的全局中间件（不在 routes[].middleware 中） */
    global: string[]
    aliases: Array<{ name: string, module?: string }>
    groups: Array<{ name: string, members: string[], module?: string }>
  }
  providers: ProviderInfo[]
  bindings: BindingInfo[]
  events: EventIntrospection[]
  jobs: JobIntrospection[]
  schedules: ScheduleIntrospection[]
  /** 开发面板（/__haze），未开启时为 undefined */
  dashboard?: { path: string }
  /** OpenAPI 文档，未开启时为 undefined */
  openapi?: { path: string, docsPath?: string }
}

export function introspectApplication(app: Application, internals: IntrospectionInternals): AppIntrospection {
  const modules = app.modules()
  const routes = app.router.list()
  const countRoutes = (match: (route: RouteInfo) => boolean): number => routes.filter(match).length

  // 定义对象 → 所属模块
  const owners = (field: Parameters<IntrospectionInternals['owned']>[0]): Map<unknown, string> => new Map(internals.owned(field)
    .filter(item => item.module)
    .map(item => [item.value, item.module!]))
  const jobOwners = owners('jobs')
  const eventOwners = owners('events')
  const listenerOwners = owners('listeners')

  const events: EventIntrospection[] = app.make(EventManager).events().map(event => ({
    name: event.name,
    module: eventOwners.get(event.definition),
    listeners: event.listeners.map(listener => ({
      name: listener.name,
      module: listenerOwners.get(listener.definition),
      queued: listener.queued,
    })),
  }))

  const jobs: JobIntrospection[] = [
    ...app.make(QueueManager).jobs(),
  ].map(([name, job]) => ({
    name,
    module: jobOwners.get(job),
    queue: job.queue,
    connection: job.connection,
    tries: job.tries,
  }))

  const schedules = scheduleInfo(app, internals.owned('schedules'))

  const aliasOwners = new Map<string, string>()
  const groupOwners = new Map<string, string>()
  for (const module of modules) {
    for (const name of Object.keys(module.definition.middleware?.alias ?? {}))
      aliasOwners.set(name, module.name)
    for (const name of Object.keys(module.definition.middleware?.groups ?? {}))
      groupOwners.set(name, module.name)
  }

  const declared = app.config.get<Record<string, { prefix?: string, domain?: string | string[] }>>('app.apps', {})
  const dashboard = resolveDashboardConfig(app)
  const openapi = resolveOpenAPIConfig(app)

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
    modules: modules.map(module => moduleInfo(module, {
      routes: countRoutes(route => route.module === module.name),
      providers: internals.providers.filter(provider => provider.module === module.name).map(provider => provider.name),
      jobs: jobs.filter(job => job.module === module.name).map(job => job.name),
      schedules: schedules.filter(task => task.module === module.name).map(task => task.name),
      events: events.filter(event => event.module === module.name).map(event => event.name),
      listeners: events.flatMap(event => event.listeners).filter(listener => listener.module === module.name).map(listener => listener.name),
    })),
    apps: Object.entries(declared).map(([name, config]) => ({
      name,
      prefix: config.prefix,
      domain: [config.domain ?? []].flat().join(', ') || undefined,
      routes: countRoutes(route => route.app === name),
    })),
    routes: [...routes],
    middleware: {
      global: internals.globalMiddleware,
      aliases: (internals.middleware?.aliases() ?? []).map(name => ({
        name,
        module: aliasOwners.get(name),
      })),
      groups: Object.entries(internals.middleware?.groups() ?? {}).map(([name, members]) => ({
        name,
        members,
        module: groupOwners.get(name),
      })),
    },
    providers: internals.providers,
    bindings: app.container.bindings(),
    events,
    jobs,
    schedules,
    dashboard: dashboard.enabled
      ? { path: dashboard.path }
      : undefined,
    openapi: openapi.enabled
      ? { path: openapi.path, docsPath: openapi.docsPath || undefined }
      : undefined,
  }
}

function moduleInfo(module: ResolvedModule, related: Omit<ModuleIntrospection, 'name' | 'source' | 'prefix' | 'as' | 'app' | 'connection' | 'migrations' | 'middleware'>): ModuleIntrospection {
  const middleware = module.definition.middleware
  return {
    name: module.name,
    source: module.source,
    prefix: module.prefix,
    as: module.as,
    app: module.app,
    connection: module.connection,
    migrations: module.migrations,
    ...related,
    middleware: {
      aliases: Object.keys(middleware?.alias ?? {}),
      groups: Object.keys(middleware?.groups ?? {}),
      global: (middleware?.global ?? []).map(ref => typeof ref === 'string'
        ? ref
        : ref.name || 'anonymous'),
    },
  }
}

/** 定时任务：模块的定义单独展开一次，得到每个模块定义了哪些任务 */
function scheduleInfo(app: Application, owned: OwnedItem[]): ScheduleIntrospection[] {
  const scheduler = app.make(Scheduler)
  const queue = app.make(QueueManager)
  const owners = new Map<string, string>()
  for (const item of owned) {
    if (!item.module)
      continue
    const schedule = new Schedule(job => queue.nameOf(job), (job, payload, options) => queue.dispatch(job, payload, options))
    try {
      runInApp(app, () => (item.value as ScheduleDefinition).define(schedule, app))
    }
    catch {
      continue
    }
    for (const task of schedule.tasks)
      owners.set(task.name, item.module)
  }
  const timezone = scheduler.config.timezone
  return scheduler.tasks().map((task) => {
    let nextRun: string | undefined
    try {
      nextRun = task.nextRun(new Date(), timezone)?.toISOString()
    }
    catch {}
    return {
      name: task.name,
      module: owners.get(task.name),
      kind: task.kind,
      expression: task.expression,
      timezone: task.timezoneName ?? timezone,
      nextRun,
      withoutOverlapping: task.preventsOverlap,
      onOneServer: task.runsOnOneServer,
    }
  })
}
