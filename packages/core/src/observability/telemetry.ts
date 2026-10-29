/**
 * 进程内的遥测事件总线：队列、邮件、缓存、事件、日志由 core 直接上报，
 * @hazejs/orm、@hazejs/ai 等包不依赖 core，通过 `globalThis[Symbol.for('hazejs.telemetry')]` 上报。
 * 没有监听者时 `recordTelemetry()` 只做一次 Set 大小判断。
 */

/** 各类遥测事件的数据（时间均为毫秒，startTime 为 Unix 时间戳） */
export interface TelemetryEvents {
  /** SQL 查询（@hazejs/orm 上报） */
  'query': {
    sql: string
    params?: unknown[]
    connection?: string
    dialect?: string
    /** 读写分离：查询在只读副本上执行 */
    replica?: boolean
    startTime: number
    duration: number
    error?: string
  }
  'cache': {
    store: string
    operation: 'get' | 'set' | 'forget' | 'add' | 'increment' | 'flush' | 'push' | 'ttl' | 'touch' | 'command'
    key?: string
    /** operation 为 command 时的数据结构命令（`hset`、`zadd` 等） */
    command?: string
    /** get 是否命中 */
    hit?: boolean
    startTime: number
    duration: number
  }
  'mail': {
    mailer: string
    driver: string
    subject: string
    from?: string
    to: string[]
    cc?: string[]
    bcc?: string[]
    html?: string
    text?: string
    messageId?: string
    startTime: number
    duration: number
    error?: string
  }
  'job.dispatched': {
    id: string
    job: string
    queue: string
    connection: string
    delay: number
    payload: unknown
    /** 任务链 ID */
    chain?: string
    /** 批次 ID */
    batch?: string
  }
  'job.processed': {
    id: string
    job: string
    queue: string
    attempt: number
    /** released：job.release() 放回队列 */
    status: 'ok' | 'retry' | 'failed' | 'released'
    startTime: number
    duration: number
    error?: string
    chain?: string
    batch?: string
  }
  'event': {
    event: string
    payload: unknown
    listeners: number
  }
  'log': {
    level: string
    msg: string
    [key: string]: unknown
  }
  'exception': {
    name: string
    message: string
    status: number
    stack?: string
  }
  /** AI 模型调用（@hazejs/ai 上报），字段对应 OpenTelemetry 的 gen_ai.* 语义约定 */
  'ai': {
    operation: 'chat' | 'stream' | 'embeddings'
    provider: string
    model: string
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    finishReason?: string
    startTime: number
    duration: number
    error?: string
  }
  /** 出站 HTTP 请求（`Http` 客户端上报，每次尝试一条；URL 与敏感请求头已脱敏） */
  'http': {
    method: string
    url: string
    /** 连接失败时没有状态码 */
    status?: number
    /** 命名客户端（config/http.ts 的 clients） */
    client?: string
    /** 第几次尝试（从 1 开始） */
    attempt: number
    requestHeaders: Record<string, string>
    responseHeaders?: Record<string, string>
    /** 请求体字节数（multipart 等无法预先得知时缺省） */
    requestSize?: number
    /** 响应体字节数（取 content-length，或已读取的响应体长度） */
    responseSize?: number
    /** 由 Http.fake() 返回的响应 */
    faked?: boolean
    startTime: number
    /** 到收到响应头为止的耗时 */
    duration: number
    error?: string
  }
}

export type TelemetryKind = keyof TelemetryEvents

export type TelemetryListener = <K extends TelemetryKind>(kind: K, data: TelemetryEvents[K]) => void

/** 挂在 globalThis 上的总线（其它包按此结构访问，勿改字段名） */
export interface TelemetryHub {
  readonly listeners: Set<TelemetryListener>
  record: (kind: string, data: object) => void
}

const kHub = Symbol.for('hazejs.telemetry')

function createHub(): TelemetryHub {
  const listeners = new Set<TelemetryListener>()
  return {
    listeners,
    record(kind, data) {
      for (const listener of listeners) {
        try {
          listener(kind as TelemetryKind, data as never)
        }
        catch {
          // 监听者出错不影响业务代码
        }
      }
    },
  }
}

/** 进程内唯一的总线（开发服务器与应用代码中的两份 core 共用） */
export function telemetryHub(): TelemetryHub {
  const g = globalThis as { [kHub]?: TelemetryHub }
  return g[kHub] ??= createHub()
}

/** 是否有监听者：上报前先判断，避免无谓地构造数据 */
export function telemetryActive(): boolean {
  return !!(globalThis as { [kHub]?: TelemetryHub })[kHub]?.listeners.size
}

/** 上报遥测事件（无监听者时为空操作） */
export function recordTelemetry<K extends TelemetryKind>(kind: K, data: TelemetryEvents[K]): void {
  const hub = (globalThis as { [kHub]?: TelemetryHub })[kHub]
  if (hub?.listeners.size)
    hub.record(kind, data)
}

/** 订阅遥测事件，返回取消订阅函数 */
export function onTelemetry(listener: TelemetryListener): () => void {
  const hub = telemetryHub()
  hub.listeners.add(listener)
  return () => {
    hub.listeners.delete(listener)
  }
}
