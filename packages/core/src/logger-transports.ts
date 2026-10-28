import type { WriteStream } from 'node:fs'
import type { LogLevel } from './logger'
import { createWriteStream, mkdirSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { globalStore } from './utils'

/** 交给传输的一条日志（与 json 格式的输出相同） */
export interface LogEntry {
  time: string
  level: LogLevel
  tag: string
  msg: string
  [key: string]: unknown
}

/** 日志传输：自定义通道实现 log()，批量 / 异步写入的传输实现 flush() 与 close() */
export interface LogTransport {
  log: (entry: LogEntry) => void
  /** 写出缓冲中的日志 */
  flush?: () => Promise<void>
  /** 应用关闭时调用：写出缓冲并释放资源 */
  close?: () => Promise<void>
}

interface ChannelBase {
  /** 本通道的最低级别，默认取 logger.level */
  level?: LogLevel
}

/** 控制台（默认通道）：按 logger.format 输出彩色文本或 JSON */
export interface ConsoleChannelConfig extends ChannelBase {
  driver: 'console'
}

/** 标准输出的 NDJSON（每行一个 JSON），不论 logger.format */
export interface JsonChannelConfig extends ChannelBase {
  driver: 'json'
  /** 默认 stdout */
  stream?: 'stdout' | 'stderr'
}

/** 文件（仅 Node / Bun / Deno），可按天轮转 */
export interface FileChannelConfig extends ChannelBase {
  driver: 'file'
  /** 相对运行目录或绝对路径，默认 storage/logs/haze.log */
  path?: string
  /** 按天轮转：写入 `haze-2026-10-28.log`，默认 true */
  daily?: boolean
  /** 按天轮转时保留的文件数（含当天），默认 14；0 表示不清理 */
  maxFiles?: number
}

type LogBody = NonNullable<RequestInit['body']>

/** 发送给日志平台的请求体格式 */
export type HttpLogFormat = 'json' | 'ndjson' | 'loki' | ((entries: LogEntry[]) => LogBody)

/** 批量 POST 到日志平台（Loki、Better Stack、Datadog、Axiom 等的 HTTP 接入） */
export interface HttpChannelConfig extends ChannelBase {
  driver: 'http'
  url: string
  /** 默认 POST */
  method?: string
  headers?: Record<string, string>
  /** json：JSON 数组（默认）；ndjson：每行一个 JSON；loki：Loki push API；或自定义函数 */
  format?: HttpLogFormat
  /** 每批条数，默认 100；达到即发送 */
  batchSize?: number
  /** 最长等待（毫秒）后发送不足一批的日志，默认 2000 */
  interval?: number
  /** 缓冲上限，超出时丢弃最旧的日志，默认 10000 */
  maxBuffer?: number
  /** loki 格式的流标签，默认 `{ service: tag, level }` */
  labels?: Record<string, string>
  /** 测试或自定义运行时使用 */
  fetch?: typeof fetch
}

/** 自定义传输 */
export interface CustomChannelConfig extends ChannelBase {
  driver: 'custom'
  transport: LogTransport | ((entry: LogEntry) => void)
}

/** 组合多个通道 */
export interface StackChannelConfig {
  driver: 'stack'
  channels: string[]
}

export type LogChannelConfig = ConsoleChannelConfig | JsonChannelConfig | FileChannelConfig | HttpChannelConfig | CustomChannelConfig | StackChannelConfig

// ---- json ---------------------------------------------------------------------

export function jsonTransport(config: Omit<JsonChannelConfig, 'driver'> = {}): LogTransport {
  const stream = config.stream === 'stderr'
    ? process.stderr
    : process.stdout
  return {
    log: entry => stream.write(`${JSON.stringify(entry)}\n`),
  }
}

// ---- file ---------------------------------------------------------------------

interface OpenFile {
  file: string
  stream: WriteStream
}

/** 同一路径的文件流在进程内共用（开发时热重载会多次创建日志器） */
const openFiles = globalStore('logger:files', () => new Map<string, OpenFile>())

function workingDir(): string {
  return process.cwd()
}

function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function fileTransport(config: Omit<FileChannelConfig, 'driver'> = {}): LogTransport {
  // 运行时求值：避免构建时的依赖追踪把运行目录下的文件视为被引用
  const path = resolve(workingDir(), config.path ?? 'storage/logs/haze.log')
  const daily = config.daily ?? true
  const maxFiles = config.maxFiles ?? 14
  const dir = dirname(path)
  const ext = extname(path)
  const base = basename(path, ext)

  const prune = async (): Promise<void> => {
    if (!daily || maxFiles <= 0)
      return
    const pattern = new RegExp(`^${escapeRegExp(base)}-\\d{4}-\\d{2}-\\d{2}${escapeRegExp(ext)}$`)
    const files = (await readdir(dir)).filter(name => pattern.test(name)).sort().reverse()
    await Promise.all(files.slice(maxFiles).map(name => rm(join(dir, name), { force: true })))
  }

  const current = (): WriteStream => {
    const file = daily
      ? join(dir, `${base}-${today()}${ext}`)
      : path
    const open = openFiles.get(path)
    if (open?.file === file)
      return open.stream
    open?.stream.end()
    mkdirSync(dir, { recursive: true })
    const stream = createWriteStream(file, { flags: 'a' })
    stream.on('error', error => process.stderr.write(`[hazejs] Failed to write log file ${file}: ${error.message}\n`))
    openFiles.set(path, { file, stream })
    // 新文件创建后清理超出保留数量的旧文件
    stream.once('open', () => void prune().catch(() => {}))
    return stream
  }

  const flush = (): Promise<void> => {
    const open = openFiles.get(path)
    return open
      ? new Promise(resolve => open.stream.write('', () => resolve()))
      : Promise.resolve()
  }

  return {
    log: entry => current().write(`${JSON.stringify(entry)}\n`),
    flush,
    async close() {
      const open = openFiles.get(path)
      if (!open)
        return
      openFiles.delete(path)
      await new Promise<void>(resolve => open.stream.end(() => resolve()))
    },
  }
}

// ---- http ---------------------------------------------------------------------

function encodeBody(entries: LogEntry[], format: HttpLogFormat, labels: Record<string, string> | undefined): { body: LogBody, contentType?: string } {
  if (typeof format === 'function') {
    return {
      body: format(entries),
    }
  }
  if (format === 'ndjson')
    return { body: `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`, contentType: 'application/x-ndjson' }
  if (format === 'loki') {
    // 按标签分组：每个流的 values 为 [纳秒时间戳字符串, 日志行]
    const streams = new Map<string, { stream: Record<string, string>, values: Array<[string, string]> }>()
    for (const entry of entries) {
      const stream = { service: entry.tag, level: entry.level, ...labels }
      const key = JSON.stringify(stream)
      const item = streams.get(key) ?? { stream, values: [] as Array<[string, string]> }
      item.values.push([
        `${BigInt(Date.parse(entry.time)) * 1_000_000n}`,
        JSON.stringify(entry),
      ])
      streams.set(key, item)
    }
    return {
      body: JSON.stringify({
        streams: [
          ...streams.values(),
        ],
      }),
      contentType: 'application/json',
    }
  }
  return {
    body: JSON.stringify(entries),
    contentType: 'application/json',
  }
}

export function httpTransport(config: Omit<HttpChannelConfig, 'driver'>): LogTransport {
  if (!config.url)
    throw new Error('Log channel driver "http" requires a url')
  const batchSize = Math.max(1, config.batchSize ?? 100)
  const interval = config.interval ?? 2000
  const maxBuffer = config.maxBuffer ?? 10_000
  const format = config.format ?? 'json'
  let buffer: LogEntry[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> = Promise.resolve()

  const send = async (entries: LogEntry[]): Promise<void> => {
    try {
      const { body, contentType } = encodeBody(entries, format, config.labels)
      const response = await (config.fetch ?? fetch)(config.url, {
        method: config.method ?? 'POST',
        headers: {
          ...(contentType && {
            'content-type': contentType,
          }),
          ...config.headers,
        },
        body,
      })
      if (!response.ok)
        throw new Error(`HTTP ${response.status} ${await response.text().catch(() => '')}`.trim())
    }
    catch (error) {
      // 不能经日志器输出（会再次进入本传输），直接写 stderr
      process.stderr.write(`[hazejs] Failed to ship ${entries.length} log entries to ${config.url}: ${(error as Error)?.message ?? error}\n`)
    }
  }

  const flush = (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    while (buffer.length) {
      const batch = buffer.slice(0, batchSize)
      buffer = buffer.slice(batchSize)
      // 按顺序发送，避免同一来源的日志乱序
      pending = pending.then(() => send(batch))
    }
    return pending
  }

  return {
    log(entry) {
      buffer.push(entry)
      if (buffer.length > maxBuffer)
        buffer.splice(0, buffer.length - maxBuffer)
      if (buffer.length >= batchSize) {
        void flush()
        return
      }
      if (!timer) {
        // 不阻止进程退出
        const handle = setTimeout(() => void flush(), interval) as { unref?: () => void }
        handle.unref?.()
        timer = handle as ReturnType<typeof setTimeout>
      }
    },
    flush,
    close: flush,
  }
}

/** 按通道配置创建传输（console 与 stack 由 Logger 处理） */
export function createTransport(name: string, config: Exclude<LogChannelConfig, ConsoleChannelConfig | StackChannelConfig>): LogTransport {
  switch (config.driver) {
    case 'json':
      return jsonTransport(config)
    case 'file':
      return fileTransport(config)
    case 'http':
      return httpTransport(config)
    case 'custom':
      return typeof config.transport === 'function'
        ? { log: config.transport }
        : config.transport
    default:
      throw new Error(`Log channel "${name}": unknown driver "${(config as { driver: string }).driver}"`)
  }
}
