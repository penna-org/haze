import type { ConsolaInstance } from 'consola'
import process from 'node:process'
import { createConsola } from 'consola'
import { colors } from './colors'
import { FRAMEWORK_NAME } from './constants'
import { isPlainObject } from './utils'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/** pretty：开发环境的彩色输出；json：每行一个 JSON，便于日志平台采集 */
export type LogFormat = 'pretty' | 'json'

export interface LoggerConfig {
  level?: LogLevel
  format?: LogFormat
  /** 记录访问日志（方法、路径、状态码、耗时、请求 ID） */
  requests?: boolean
  tag?: string
  /** 自定义 json 输出目标，默认 error 写 stderr、其余写 stdout */
  write?: (line: string, level: LogLevel) => void
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

interface Shared {
  level: number
  format: LogFormat
  tag: string
  consola: ConsolaInstance
  write: (line: string, level: LogLevel) => void
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
    if (LEVELS.info > this.#shared.level)
      return
    const duration = Math.round(entry.duration * 10) / 10
    if (this.#shared.format === 'json') {
      this.#json('info', `${entry.method} ${entry.path} ${entry.status}`, { ...entry, duration })
      return
    }
    const status = entry.status >= 500
      ? colors.red(String(entry.status))
      : entry.status >= 400
        ? colors.yellow(String(entry.status))
        : colors.green(String(entry.status))
    const context = this.#prettyContext()
    this.#shared.consola.log(`${colors.bold(entry.method)} ${entry.path} ${status} ${colors.gray(`${duration}ms`)}${context
      ? ` ${context}`
      : ''}`)
  }

  #log(method: Method, message: unknown, args: unknown[]): void {
    const level = METHOD_LEVEL[method]
    if (LEVELS[level] > this.#shared.level)
      return
    if (this.#shared.format === 'json') {
      this.#json(level, message, {}, args)
      return
    }
    const suffix = this.#prettyContext()
    if (suffix)
      this.#shared.consola[method](message, ...args, suffix)
    else
      this.#shared.consola[method](message, ...args)
  }

  #json(level: LogLevel, message: unknown, fields: LogContext, args: unknown[] = []): void {
    const entry: LogContext = {
      time: new Date().toISOString(),
      level,
      tag: this.#shared.tag,
      msg: '',
      ...this.#context,
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
    this.#shared.write(JSON.stringify(entry), level)
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
  return {
    level,
    format: config.format ?? 'pretty',
    tag,
    consola: createConsola({ level }).withTag(tag),
    write: config.write ?? defaultWrite,
  }
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
