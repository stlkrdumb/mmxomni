/**
 * mmxomni — stderr-only logger.
 *
 * `stdout` is reserved for the MCP stdio transport; all logs and progress
 * output go to `process.stderr` (binding for AC-11). Verbosity is controlled
 * by a single `--log-level` flag (`error|warn|info|debug`), default `warn`.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = 'warn';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel];
}

function emit(level: LogLevel, parts: unknown[]): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const line = parts
    .map((p) => (typeof p === 'string' ? p : safeStringify(p)))
    .join(' ');
  process.stderr.write(`[${ts}] [${level}] ${line}\n`);
}

function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) {
      return value.stack ?? `${value.name}: ${value.message}`;
    }
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  error: (...parts: unknown[]): void => emit('error', parts),
  warn: (...parts: unknown[]): void => emit('warn', parts),
  info: (...parts: unknown[]): void => emit('info', parts),
  debug: (...parts: unknown[]): void => emit('debug', parts),
};
