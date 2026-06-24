import type * as vscode from 'vscode'

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug'

export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

export type LogFields = Record<string, unknown>

const LEVELS: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export function createOutputLogger(channel: vscode.OutputChannel, level: () => LogLevel): Logger {
  return {
    debug: (event, fields) => append(channel, level(), 'debug', event, fields),
    info: (event, fields) => append(channel, level(), 'info', event, fields),
    warn: (event, fields) => append(channel, level(), 'warn', event, fields),
    error: (event, fields) => append(channel, level(), 'error', event, fields),
  }
}

function append(
  channel: vscode.OutputChannel,
  configuredLevel: LogLevel,
  messageLevel: Exclude<LogLevel, 'off'>,
  event: string,
  fields: LogFields | undefined,
) {
  if (LEVELS[configuredLevel] < LEVELS[messageLevel]) return

  const timestamp = new Date().toISOString()
  const payload = fields && Object.keys(fields).length > 0 ? ` ${stringify(fields)}` : ''
  channel.appendLine(`${timestamp} ${messageLevel.toUpperCase()} ${event}${payload}`)
}

function stringify(fields: LogFields): string {
  try {
    return JSON.stringify(fields, sanitize)
  } catch {
    return JSON.stringify({ logError: 'fields_not_serializable' })
  }
}

function sanitize(key: string, value: unknown): unknown {
  if (/token|secret|authorization|password/i.test(key)) return '<redacted>'
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 497)}...`
  if (value instanceof Error) return { name: value.name, message: value.message }
  return value
}
