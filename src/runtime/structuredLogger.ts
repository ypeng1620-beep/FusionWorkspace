/**
 * Structured Logger — JSON-formatted logging with levels and optional file output.
 *
 * Produces ndjson (newline-delimited JSON) suitable for ingestion by
 * log aggregators (ELK, Loki, CloudWatch, etc.).
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export interface StructuredLoggerConfig {
  /** Minimum log level to emit (default: 'info'). */
  minLevel?: LogLevel
  /** Optional file path for persistent log output (ndjson). */
  filePath?: string
  /** Whether to also write to stdout (default: true). */
  stdout?: boolean
  /** Default metadata attached to every log line. */
  defaultMetadata?: Record<string, unknown>
}

export interface StructuredLogger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  /** Create a child logger with additional default metadata. */
  child(meta: Record<string, unknown>): StructuredLogger
  /** Set the minimum log level at runtime. */
  setLevel(level: LogLevel): void
}

export function createStructuredLogger(config: StructuredLoggerConfig = {}): StructuredLogger {
  let minLevel = config.minLevel ?? 'info'
  const stdout = config.stdout ?? true
  const baseMeta = config.defaultMetadata ?? {}
  const filePath = config.filePath

  function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return

    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...baseMeta,
      ...(meta ?? {}),
    }

    const line = JSON.stringify(entry)

    if (stdout) {
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }

    if (filePath) {
      try {
        const dir = dirname(filePath)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        appendFileSync(filePath, line + '\n', 'utf-8')
      } catch {
        // File output failure is non-fatal
      }
    }
  }

  return {
    debug(msg, meta) { log('debug', msg, meta) },
    info(msg, meta) { log('info', msg, meta) },
    warn(msg, meta) { log('warn', msg, meta) },
    error(msg, meta) { log('error', msg, meta) },
    child(meta) {
      return createStructuredLogger({
        minLevel,
        stdout,
        filePath,
        defaultMetadata: { ...baseMeta, ...meta },
      })
    },
    setLevel(level) { minLevel = level },
  }
}

/** Default singleton logger — configure before first use. */
let _defaultLogger: StructuredLogger | null = null

export function getLogger(): StructuredLogger {
  if (!_defaultLogger) {
    _defaultLogger = createStructuredLogger()
  }
  return _defaultLogger
}

export function setLogger(logger: StructuredLogger): void {
  _defaultLogger = logger
}
