import type { DevframeJsonRenderSpec } from '@devframes/json-render'
import type { AppSnapshot, RouteRow } from './inspect'

/** 最近一次（重新）加载应用的结果 */
export interface ReloadStatus {
  ok: boolean
  file?: string
  duration: number
  error?: unknown
}

/** 路由面板的搜索动作（json-render 的 action 名即 RPC 名） */
export const ROUTES_FILTER_ACTION = 'hazejs:routes:filter'

const STATUS_VARIANTS = ['info', 'success', 'danger'] as const

const MODULE_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'source', label: 'Source' },
  { key: 'prefix', label: 'Prefix' },
  { key: 'as', label: 'Route name prefix' },
  { key: 'app', label: 'App' },
  { key: 'connection', label: 'Connection' },
  { key: 'routes', label: 'Routes' },
]

const APP_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'prefix', label: 'Prefix' },
  { key: 'domain', label: 'Domain' },
  { key: 'routes', label: 'Routes' },
]

const ROUTE_COLUMNS = [
  { key: 'method', label: 'Method' },
  { key: 'path', label: 'Path' },
  { key: 'name', label: 'Name' },
  { key: 'handler', label: 'Handler' },
  { key: 'middleware', label: 'Middleware' },
  { key: 'module', label: 'Module' },
  { key: 'app', label: 'App' },
]

/** 概览面板：应用信息、模块、子应用（数据放在 state 中，重载时只发补丁） */
export function overviewSpec(): DevframeJsonRenderSpec {
  return {
    root: 'root',
    elements: {
      root: {
        type: 'Stack',
        props: { direction: 'column', gap: 16, padding: 16 },
        children: ['status', 'info', 'modules', 'apps'],
      },
      // Badge 的 variant 不能绑定 state：每种状态一个 Badge，按 /status/variant 显示
      status: {
        type: 'Stack',
        props: { direction: 'row' },
        children: STATUS_VARIANTS.map(variant => `status-${variant}`),
      },
      ...Object.fromEntries(STATUS_VARIANTS.map(variant => [
        `status-${variant}`,
        {
          type: 'Badge',
          props: {
            text: { $state: '/status/text' },
            variant,
          },
          visible: { $state: '/status/variant', eq: variant },
          children: [],
        },
      ])),
      info: {
        type: 'Card',
        props: { title: 'Application' },
        children: ['infoTable'],
      },
      infoTable: {
        type: 'KeyValueTable',
        props: {
          data: { $state: '/info' },
        },
        children: [],
      },
      modules: {
        type: 'Card',
        props: {
          title: { $state: '/modulesTitle' },
        },
        children: ['modulesTable'],
      },
      modulesTable: {
        type: 'DataTable',
        props: {
          columns: MODULE_COLUMNS,
          rows: { $state: '/modules' },
        },
        children: [],
      },
      apps: {
        type: 'Card',
        props: {
          title: { $state: '/appsTitle' },
        },
        children: ['appsTable'],
      },
      appsTable: {
        type: 'DataTable',
        props: {
          columns: APP_COLUMNS,
          rows: { $state: '/apps' },
        },
        children: [],
      },
    },
    state: overviewState(undefined, undefined),
  }
}

export function overviewState(snapshot: AppSnapshot | undefined, reload: ReloadStatus | undefined): Record<string, unknown> {
  const info: Record<string, unknown> = snapshot
    ? {
        'Name': snapshot.app.name,
        'Mode': snapshot.app.mode,
        'Debug': snapshot.app.debug,
        'URL': snapshot.app.url ?? '-',
        'Root': snapshot.app.rootDir,
        'Source': snapshot.app.srcDir,
        'Node.js': snapshot.app.node,
        'Routes': snapshot.routes.length,
        'Dev dashboard': snapshot.dashboard?.path ?? 'disabled',
      }
    : {}
  return {
    status: statusOf(reload),
    info,
    modulesTitle: `Modules (${snapshot?.modules.length ?? 0})`,
    modules: snapshot?.modules.map(module => ({
      ...module,
      prefix: module.prefix || '/',
      app: module.app ?? '-',
      connection: module.connection ?? '-',
    })) ?? [],
    appsTitle: `Apps (${snapshot?.apps.length ?? 0})`,
    apps: snapshot?.apps.map(app => ({ ...app, prefix: app.prefix ?? '-', domain: app.domain ?? '-' })) ?? [],
  }
}

function statusOf(reload: ReloadStatus | undefined): { text: string, variant: string } {
  if (!reload)
    return { text: 'Starting…', variant: 'info' }
  const ms = `${Math.round(reload.duration)}ms`
  if (!reload.ok) {
    return { text: `Failed to load${reload.file
      ? ` after ${reload.file}`
      : ''}: ${errorSummary(reload.error)}`, variant: 'danger' }
  }
  return {
    text: reload.file
      ? `Reloaded in ${ms} (${reload.file})`
      : `Started in ${ms}`,
    variant: 'success',
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[\d;]*m/g

/** 去掉终端颜色的完整错误信息 */
export function errorText(error: unknown): string {
  return (error instanceof Error
    ? error.message
    : String(error)).replace(ANSI_RE, '')
}

/** 合并为一行并截断的错误信息，用于状态徽标 */
export function errorSummary(error: unknown, max = 160): string {
  const line = errorText(error).replace(/\s+/g, ' ').trim()
  return line.length > max
    ? `${line.slice(0, max)}…`
    : line
}

/** 路由面板：搜索框 + 路由表 */
export function routesSpec(): DevframeJsonRenderSpec {
  return {
    root: 'root',
    elements: {
      root: {
        type: 'Stack',
        props: { direction: 'column', gap: 12, padding: 16 },
        children: ['toolbar', 'table'],
      },
      toolbar: {
        type: 'Stack',
        props: { direction: 'row', gap: 12, align: 'center' },
        children: ['searchBox', 'summary'],
      },
      searchBox: {
        type: 'Stack',
        props: { direction: 'column', flex: 1 },
        children: ['search'],
      },
      search: {
        type: 'TextInput',
        props: {
          type: 'search',
          placeholder: 'Filter by method, path, name, handler, middleware…',
          value: { $bindState: '/query' },
        },
        on: {
          change: {
            action: ROUTES_FILTER_ACTION,
            params: {
              query: { $state: '/query' },
            },
          },
        },
        children: [],
      },
      summary: {
        type: 'Text',
        props: {
          text: { $state: '/summary' },
          variant: 'caption',
          color: 'muted',
        },
        children: [],
      },
      table: {
        type: 'DataTable',
        props: {
          columns: ROUTE_COLUMNS,
          rows: { $state: '/rows' },
        },
        children: [],
      },
    },
    state: { query: '', summary: '', rows: [] },
  }
}

export function routesState(all: readonly RouteRow[], rows: readonly RouteRow[]): Record<string, unknown> {
  return {
    summary: rows.length === all.length
      ? `${all.length} routes`
      : `${rows.length} / ${all.length} routes`,
    rows,
  }
}
