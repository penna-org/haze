import type { InitHubOptions } from '@devframes/hub/initiate'
import type { AppIntrospection } from '@hazejs/core'
import type { DevtoolsSource } from './hub'
import type { AppSnapshot, RouteRow } from './inspect'
import type { ReloadStatus } from './views'
import { toJsonRenderDockEntry } from '@devframes/json-render/hub'
import { createJsonRenderView } from '@devframes/json-render/node'
import { FRAME_ID } from './frame'
import { AI_ICON, API_ICON, DASHBOARD_ICON, GRAPH_ICON, INTERNALS_ICON, LOGO, OVERVIEW_ICON, REQUESTS_ICON, ROUTES_ICON, TASKS_ICON } from './icons'
import { filterRoutes, inspectApp } from './inspect'
import { errorSummary, errorText, internalsSpec, internalsState, overviewSpec, overviewState, ROUTES_FILTER_ACTION, routesSpec, routesState } from './views'

type HubContext = Parameters<NonNullable<InitHubOptions['configure']>>[0]

export const GROUP_ID = 'hazejs:group'
const RELOAD_MESSAGE = 'hazejs:reload'

/** SPA 自己托管的面板（hazejs 页面的默认页是模块联动图） */
export const FRAME_DOCK = {
  title: 'Graph',
  titleLocales: { 'zh-CN': '模块联动' },
  icon: GRAPH_ICON,
  groupId: GROUP_ID,
  defaultOrder: 15,
}

interface PanelOptions {
  source: DevtoolsSource
  /**
   * 实时模式（开发服务器）：随应用重载刷新，并提供依赖运行时记录的面板（请求、AI、任务、开发面板）。
   * 静态报告只包含应用结构：概览、联动图、路由、容器与事件。
   */
  live: boolean
}

/** 注册 hazejs 的面板（initHub / buildHub 的 configure 共用） */
export function registerPanels(ctx: HubContext, { source, live }: PanelOptions): void {
  let snapshot: AppSnapshot | undefined
  let reload: ReloadStatus | undefined
  let query = ''

  const overview = createJsonRenderView(ctx, {
    id: 'hazejs-overview',
    title: 'Overview',
    spec: overviewSpec(),
  })
  const routes = createJsonRenderView(ctx, {
    id: 'hazejs-routes',
    title: 'Routes',
    spec: routesSpec({ search: live }),
  })
  const internals = createJsonRenderView(ctx, {
    id: 'hazejs-internals',
    title: 'Internals',
    spec: internalsSpec(),
  })

  ctx.docks.register({
    type: 'group',
    id: GROUP_ID,
    title: 'hazejs',
    icon: LOGO,
    category: 'framework',
    defaultChildId: 'hazejs:overview',
  })
  ctx.docks.register(toJsonRenderDockEntry(overview, {
    id: 'hazejs:overview',
    title: 'Overview',
    titleLocales: { 'zh-CN': '概览' },
    icon: OVERVIEW_ICON,
    groupId: GROUP_ID,
    defaultOrder: 10,
  }))
  const routesDock = ctx.docks.register(toJsonRenderDockEntry(routes, {
    id: 'hazejs:routes',
    title: 'Routes',
    titleLocales: { 'zh-CN': '路由' },
    icon: ROUTES_ICON,
    groupId: GROUP_ID,
    defaultOrder: 20,
  }))
  ctx.docks.register(toJsonRenderDockEntry(internals, {
    id: 'hazejs:internals',
    title: 'Internals',
    titleLocales: { 'zh-CN': '容器与事件' },
    icon: INTERNALS_ICON,
    groupId: GROUP_ID,
    defaultOrder: 50,
  }))

  function patch(view: { patchState: (ops: any[]) => void }, state: Record<string, unknown>): void {
    view.patchState(Object.entries(state).map(([key, value]) => ({ op: 'replace', path: `/${key}`, value })))
  }

  function renderRoutes(): void {
    const all: RouteRow[] = snapshot?.routes ?? []
    patch(routes, routesState(all, filterRoutes(all, query)))
  }

  /** 读取应用结构并刷新各面板，返回完整的内省结果 */
  function refresh(): AppIntrospection | undefined {
    const app = source.app
    let details: AppIntrospection | undefined
    if (app) {
      try {
        snapshot = inspectApp(app)
        details = app.introspect()
      }
      catch (error) {
        void ctx.messages.add({ message: 'Failed to inspect the app', description: (error as Error).message, level: 'error' })
      }
    }
    patch(overview, overviewState(snapshot, reload))
    renderRoutes()
    patch(internals, internalsState(details))
    routesDock.update({
      badge: snapshot
        ? String(snapshot.routes.length)
        : undefined,
    })
    return details
  }

  if (!live) {
    refresh()
    patch(overview, {
      status: { text: `Static report · ${new Date().toLocaleString()}`, variant: 'info' },
    })
    return
  }

  // 以下面板依赖运行中的应用与开发面板的记录；SPA 的其它页面与默认页（联动图）同一个地址，只是 hash 不同
  const frameUrl = (ctx.docks.views.get(FRAME_ID) as { url?: string } | undefined)?.url ?? `/__${FRAME_ID}/`
  const page = (id: string, title: string, zh: string, icon: typeof GRAPH_ICON, defaultOrder: number): void => void ctx.docks.register({
    type: 'iframe',
    id: `hazejs:${id}`,
    title,
    titleLocales: { 'zh-CN': zh },
    icon,
    groupId: GROUP_ID,
    defaultOrder,
    url: `${frameUrl}#/${id}`,
  })
  page('requests', 'Requests', '请求', REQUESTS_ICON, 25)
  page('ai', 'AI', 'AI', AI_ICON, 40)
  page('tasks', 'Tasks', '任务与队列', TASKS_ICON, 45)
  // OpenAPI 文档页面（/docs）由应用提供，未开启时隐藏
  const apiDock = ctx.docks.register({
    type: 'iframe',
    id: 'hazejs:api',
    title: 'API Docs',
    titleLocales: { 'zh-CN': '接口文档' },
    icon: API_ICON,
    groupId: GROUP_ID,
    defaultOrder: 55,
    url: '/docs',
    when: 'false',
  })
  // /__haze 开发面板（请求、查询、队列、邮件……）由应用自己提供，这里以 iframe 嵌入
  const dashboardDock = ctx.docks.register({
    type: 'iframe',
    id: 'hazejs:dashboard',
    title: 'Dashboard',
    titleLocales: { 'zh-CN': '开发面板' },
    icon: DASHBOARD_ICON,
    groupId: GROUP_ID,
    defaultOrder: 60,
    url: '/__haze/',
    when: 'false',
  })

  ctx.rpc.register({
    name: ROUTES_FILTER_ACTION,
    type: 'action',
    jsonSerializable: true,
    handler: (params?: { query?: unknown }) => {
      query = typeof params?.query === 'string'
        ? params.query
        : ''
      renderRoutes()
    },
  })

  function refreshLive(): void {
    const details = refresh()
    apiDock.update(details?.openapi?.docsPath
      ? { url: details.openapi.docsPath, when: undefined }
      : { when: 'false' })
    dashboardDock.update(details?.dashboard
      ? { url: `${details.dashboard.path}/`, when: undefined }
      : { when: 'false' })
  }

  source.onReload((result) => {
    reload = result
    refreshLive()
    // 同一条消息：失败时出现 / 更新，恢复后移除
    if (result.ok) {
      void ctx.messages.remove(RELOAD_MESSAGE)
      return
    }
    void ctx.messages.add({
      id: RELOAD_MESSAGE,
      message: `Failed to reload the app${result.file
        ? ` (${result.file})`
        : ''}`,
      description: errorSummary(result.error),
      stacktrace: errorText(result.error),
      level: 'error',
    })
  })
  refreshLive()
}
