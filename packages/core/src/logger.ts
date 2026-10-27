import type { ConsolaInstance } from 'consola'
import { createConsola } from 'consola'
import { FRAMEWORK_NAME } from './constants'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

export interface LoggerConfig {
  level?: LogLevel
  tag?: string
}

const LEVELS: Record<LogLevel, number> = {
  silent: Number.NEGATIVE_INFINITY,
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
  trace: 5,
}

export class Logger {
  readonly #consola: ConsolaInstance

  constructor(config: LoggerConfig | ConsolaInstance = {}) {
    this.#consola = 'withTag' in config
      ? config
      : createConsola({ level: LEVELS[config.level ?? 'info'] }).withTag(config.tag ?? FRAMEWORK_NAME)
  }

  error(message: unknown, ...args: unknown[]): void {
    this.#consola.error(message, ...args)
  }

  warn(message: unknown, ...args: unknown[]): void {
    this.#consola.warn(message, ...args)
  }

  info(message: unknown, ...args: unknown[]): void {
    this.#consola.info(message, ...args)
  }

  success(message: unknown, ...args: unknown[]): void {
    this.#consola.success(message, ...args)
  }

  debug(message: unknown, ...args: unknown[]): void {
    this.#consola.debug(message, ...args)
  }

  withTag(tag: string): Logger {
    return new Logger(this.#consola.withTag(tag))
  }
}
