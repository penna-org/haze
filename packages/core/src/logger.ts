import type { ConsolaInstance } from 'consola'
import type { LogChannelConfig, LogEntry, LogTransport } from './logger-transports'
import process from 'node:process'
import { createConsola } from 'consola'
import { colors } from './colors'
import { FRAMEWORK_NAME } from './constants'
import { createTransport } from './logger-transports'
import { activeTraceIds } from './observability/otel'
import { recordTelemetry, telemetryActive } from './observability/telemetry'
import { isPlainObject, jsonReplacer } from './utils'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** pretty：开发环境的彩色输出；json：每行一个 JSON，便于日志平台采集 */
export type LogFormat = 'pretty' | 'json'

export interface LoggerConfig {
  level?: LogLevel
  /** console 通道的格式 */
  format?: LogFormat
  /** 记录访问日志（方法、路径、状态码、耗时、请求 ID） */
  requests?: boolean
  tag?: string
  /** 自定义 console 通道 json 格式的输出目标，默认 error 写 stderr、其余写 stdout */
  write?: (line: string, level: LogLevel) => void
  /**
   * 写入的通道（对应 Laravel 的 default / stack），默认 `'console'`：
   * `channel: ['console', 'file']`，或指向 `driver: 'stack'` 的通道名
   */
  channel?: string | string[]
  /**
   * 通道定义。`console`（控制台，按 format 输出）与 `json`（标准输出 NDJSON）无需定义即可使用：
   *
   * ```ts
   * channels: {
   *   file: { driver: 'file', path: 'storage/logs/app.log', daily: true, maxFiles: 14 },
   *   loki: { driver: 'http', url: 'http://loki:3100/loki/api/v1/push', format: 'loki', level: 'warn' },
   * }
   * ```
   */
  channels?: Record<string, LogChannelConfig>
}

export type LogContext = Record<string, unknown>

export interface AccessLogEntry {
  method: string
  path: string
  status: number
  /** 毫秒 */
  duration: number
}

type Method = 'error' | 'warn' | 'info' | 'success' | 'debug' | 'trace'

const LEVELS: Record<LogLevel, number> = {
  silent: Number.NEGATIVE_INFINITY,
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
  trace: 5,
}

const METHOD_LEVEL: Record<Method, LogLevel> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  success: 'info',
  debug: 'debug',
  trace: 'trace',
}

/** 已解析的通道：console 走 consola / write，其余为传输 */
type Channel = { kind: 'console', level: number } | { kind: 'transport', level: number, transport: LogTransport }

interface Shared {
  /** 所有通道中最详细的级别（快速过滤） */
  level: number
  format: LogFormat
  tag: string
  consola: ConsolaInstance
  write: (line: string, level: LogLevel) => void
  channels: Channel[]
  config: LoggerConfig
  /** 各通道的传输（按名称缓存，channel() 切换时复用） */
  transports: Map<string, LogTransport>
}

/** 子日志器复用父级的输出配置 */
const kShared = Symbol('shared')

export class Logger {
  readonly #shared: Shared
  readonly #context: LogContext

  constructor(config: LoggerConfig = {}, context: LogContext = {}) {
    this.#shared = (config as { [kShared]?: Shared })[kShared] ?? createShared(config)
    this.#context = context
  }

  get format(): LogFormat {
    return this.#shared.format
  }

  /** 携带上下文的子日志器，例如 `logger.child({ requestId })` */
  child(context: LogContext): Logger {
    const Ctor = this.constructor as typeof Logger
    return new Ctor({ [kShared]: this.#shared } as LoggerConfig, {
      ...this.#context,
      ...context,
    })
  }

  /** 只写入指定通道的日志器：`logger.channel('audit').info(...)` */
  channel(...names: string[]): Logger {
    const Ctor = this.constructor as typeof Logger
    return new Ctor({
      [kShared]: deriveShared(this.#shared, names),
    } as LoggerConfig, this.#context)
  }

  /** @deprecated 使用 child({ ... }) */
  withTag(tag: string): Logger {
    return this.child({ tag })
  }

  error(message: unknown, ...args: unknown[]): void {
    this.#log('error', message, args)
  }

  warn(message: unknown, ...args: unknown[]): void {
    this.#log('warn', message, args)
  }

  info(message: unknown, ...args: unknown[]): void {
    this.#log('info', message, args)
  }

  success(message: unknown, ...args: unknown[]): void {
    this.#log('success', message, args)
  }

  debug(message: unknown, ...args: unknown[]): void {
    this.#log('debug', message, args)
  }

  trace(message: unknown, ...args: unknown[]): void {
    this.#log('trace', message, args)
  }

  /** 访问日志（info 级别） */
  access(entry: AccessLogEntry): void {
    const shared = this.#shared
    if (LEVELS.info > shared.level)
      return
    const duration = Math.round(entry.duration * 10) / 10
    const fields = { ...entry, duration }
    const msg = `${entry.method} ${entry.path} ${entry.status}`
    let json: LogEntry | undefined
    for (const channel of shared.channels) {
      if (LEVELS.info > channel.level)
        continue
      if (channel.kind === 'transport') {
        json ??= this.#entry('info', msg, fields)
        channel.transport.log(json)
      }
      else if (shared.format === 'json') {
        json ??= this.#entry('info', msg, fields)
        shared.write(JSON.stringify(json, jsonReplacer), 'info')
      }
      else {
        const status = entry.status >= 500
          ? colors.red(String(entry.status))
          : entry.status >= 400
            ? colors.yellow(String(entry.status))
            : colors.green(String(entry.status))
        const context = this.#prettyContext()
        shared.consola.log(`${colors.bold(entry.method)} ${entry.path} ${status} ${colors.gray(`${duration}ms`)}${context
          ? ` ${context}`
          : ''}`)
      }
    }
  }

  /** 写出各通道缓冲中的日志（http 批量发送、文件流） */
  async flush(): Promise<void> {
    await Promise.all([
      ...this.#shared.transports.values(),
    ].map(transport => transport.flush?.()))
  }

  /** 写出缓冲并释放通道资源（应用关闭时调用） */
  async close(): Promise<void> {
    const transports = [
      ...this.#shared.transports.values(),
    ]
    this.#shared.transports.clear()
    await Promise.all(transports.map(transport => (transport.close ?? transport.flush)?.()))
  }

  #log(method: Method, message: unknown, args: unknown[]): void {
    const level = METHOD_LEVEL[method]
    const shared = this.#shared
    const severity = LEVELS[level]
    if (severity > shared.level)
      return
    let json: LogEntry | undefined
    for (const channel of shared.channels) {
      if (severity > channel.level)
        continue
      if (channel.kind === 'transport') {
        json ??= this.#entry(level, message, {}, args)
        channel.transport.log(json)
      }
      else if (shared.format === 'json') {
        json ??= this.#entry(level, message, {}, args)
        shared.write(JSON.stringify(json, jsonReplacer), level)
      }
      else {
        const suffix = this.#prettyContext()
        if (suffix)
          shared.consola[method](message, ...args, suffix)
        else
          shared.consola[method](message, ...args)
      }
    }
    // 开发面板记录日志
    if (telemetryActive())
      recordTelemetry('log', json ?? this.#entry(level, message, {}, args))
  }

  #entry(level: LogLevel, message: unknown, fields: LogContext, args: unknown[] = []): LogEntry {
    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      tag: this.#shared.tag,
      msg: '',
      ...this.#context,
      // 有活动的 OpenTelemetry span 时关联链路
      ...activeTraceIds(),
      ...fields,
    }
    const text: string[] = []
    for (const value of [message, ...args]) {
      if (value instanceof Error)
        entry.err ??= serializeError(value)
      else if (isPlainObject(value))
        Object.assign(entry, value)
      else if (value !== undefined)
        text.push(String(value))
    }
    entry.msg = text.join(' ') || (entry.err as { message?: string } | undefined)?.message || ''
    return entry
  }

  #prettyContext(): string {
    const entries = Object.entries(this.#context)
    // 开发输出中请求 ID 只显示前 8 位，JSON 日志保留完整值
    return entries.length
      ? colors.gray(entries.map(([key, value]) => `${key}=${key === 'requestId'
          ? String(value).slice(0, 8)
          : String(value)}`).join(' '))
      : ''
  }
}

function createShared(config: LoggerConfig): Shared {
  const tag = config.tag ?? FRAMEWORK_NAME
  const level = LEVELS[config.level ?? 'info']
  return resolveChannels({
    level,
    format: config.format ?? 'pretty',
    tag,
    consola: createConsola({ level }).withTag(tag),
    write: config.write ?? defaultWrite,
    channels: [],
    config,
    transports: new Map(),
  }, config.channel ?? 'console')
}

function deriveShared(parent: Shared, names: string[]): Shared {
  return resolveChannels({ ...parent, channels: [] }, names)
}

/** 展开 stack，创建（或复用）各通道的传输 */
function resolveChannels(shared: Shared, selection: string | string[]): Shared {
  const config = shared.config
  const base = LEVELS[config.level ?? 'info']
  const definitions: Record<string, LogChannelConfig> = {
    console: { driver: 'console' },
    json: { driver: 'json' },
    ...config.channels,
  }
  const seen = new Set<string>()
  const channels: Channel[] = []
  let consoleLevel: number | undefined

  const add = (name: string, trail: string[]): void => {
    const definition = definitions[name]
    if (!definition)
      throw new Error(`Log channel "${name}" is not defined in config/logger.ts`)
    if (definition.driver === 'stack') {
      if (trail.includes(name))
        throw new Error(`Log channel stack "${name}" includes itself`)
      definition.channels.forEach(child => add(child, [...trail, name]))
      return
    }
    if (seen.has(name))
      return
    seen.add(name)
    const level = definition.level === undefined
      ? base
      : LEVELS[definition.level]
    if (definition.driver === 'console') {
      consoleLevel = level
      channels.push({ kind: 'console', level })
      return
    }
    let transport = shared.transports.get(name)
    if (!transport) {
      transport = createTransport(name, definition)
      shared.transports.set(name, transport)
    }
    channels.push({ kind: 'transport', level, transport })
  }

  for (const name of Array.isArray(selection)
    ? selection
    : [selection])
    add(name, [])

  shared.channels = channels
  shared.level = Math.max(Number.NEGATIVE_INFINITY, ...channels.map(channel => channel.level))
  // console 通道有自己的级别时，consola 按该级别创建
  if (consoleLevel !== undefined && consoleLevel !== base)
    shared.consola = createConsola({ level: consoleLevel }).withTag(shared.tag)
  return shared
}

function serializeError(error: Error): LogContext {
  return {
    name: error.name,
    message: error.message,
    ...((error as { status?: number }).status !== undefined && { status: (error as { status?: number }).status }),
    stack: error.stack,
  }
}

function defaultWrite(line: string, level: LogLevel): void {
  (level === 'error'
    ? process.stderr
    : process.stdout).write(`${line}\n`)
}
