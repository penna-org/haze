export type PathMatcher = string | RegExp

/** OpenTelemetry 集成（需安装 @opentelemetry/api，SDK 与导出器由项目自行初始化） */
export interface OpenTelemetryConfig {
  /** 默认 false；开启后未安装 @opentelemetry/api 时给出警告并保持空操作 */
  enabled?: boolean
  /** tracer / meter 名称，默认 hazejs */
  name?: string
  /** 各类 span 的开关：http / db / mail / queue / ai 默认开启，cache 默认关闭（数量多） */
  traces?: {
    http?: boolean
    db?: boolean
    cache?: boolean
    mail?: boolean
    queue?: boolean
    ai?: boolean
  }
  /** 指标：http.server.request.duration、http.server.active_requests、队列任务耗时与失败数，默认开启 */
  metrics?: boolean
  /** 不创建请求 span 的路径（字符串为前缀），默认包含健康检查与 /__haze */
  ignorePaths?: PathMatcher[]
}

/** 开发面板（仅 development 模式） */
export interface DashboardConfig {
  /** development 下默认开启；production / test 下始终关闭 */
  enabled?: boolean
  /** 面板路径，默认 /__haze */
  path?: string
  /** 每类记录保留的条数（环形缓冲），默认 500 */
  limit?: number
  /** 额外需要隐藏的请求头（默认已包含 authorization、cookie 等） */
  redactHeaders?: string[]
  /** 不记录的请求路径（字符串为前缀），面板自身与健康检查始终忽略 */
  ignorePaths?: PathMatcher[]
}

/** `config/observability.ts` */
export interface ObservabilityConfig {
  otel?: OpenTelemetryConfig
  dashboard?: DashboardConfig
}

/** `config/observability.ts` 的默认导出 */
export function defineObservabilityConfig(config: ObservabilityConfig | (() => ObservabilityConfig)): ObservabilityConfig | (() => ObservabilityConfig) {
  return config
}

/** 路径是否命中（字符串按前缀匹配：`/health` 匹配 `/health` 与 `/health/live`） */
export function matchesPath(path: string, matchers: readonly PathMatcher[]): boolean {
  return matchers.some(matcher => typeof matcher === 'string'
    ? path === matcher || path.startsWith(matcher.endsWith('/')
      ? matcher
      : `${matcher}/`)
    : matcher.test(path))
}
