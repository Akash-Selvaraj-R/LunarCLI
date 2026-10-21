import { Writable } from 'node:stream'

import { redactSecrets, redactText } from '../utils/redact.js'

/**
 * Small leveled logger.
 *
 * - Normal mode: info/warn/error only.
 * - Debug mode (`--debug` or `LUNAR_DEBUG=1`): adds debug diagnostics.
 * - Output goes to stderr so it never corrupts the TUI on stdout.
 * - Everything passes through `redactSecrets` (key names) and
 *   `redactText` (secret-shaped values) — API keys are never printed.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  readonly level: LogLevel
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
  /** Return a logger with a different level. */
  withLevel(level: LogLevel): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  /** Stream for output (defaults to stderr). */
  stream?: NodeJS.WritableStream
  /** Include timestamps in output (defaults to true). */
  timestamps?: boolean
}

function formatContext(context: Record<string, unknown> | undefined): string {
  if (!context || Object.keys(context).length === 0) return ''
  return ` ${redactText(JSON.stringify(redactSecrets(context)))}`
}

/** Create a logger. Use `createLogger({level: 'debug'})` in debug mode. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const stream = options.stream ?? process.stderr
  const timestamps = options.timestamps ?? true

  function write(entryLevel: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return
    const time = timestamps ? `${new Date().toISOString()} ` : ''
    stream.write(`${time}[${entryLevel}] ${redactText(message)}${formatContext(context)}\n`)
  }

  return {
    level,
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    withLevel: (nextLevel) => createLogger({ ...options, level: nextLevel }),
  }
}

/** A silent logger for tests. */
export function createSilentLogger(): Logger {
  const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() })
  return createLogger({ level: 'error', stream: sink })
}
