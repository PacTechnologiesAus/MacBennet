/**
 * Tiny level-filtered console logger.
 *
 * This is the worker's own operational logging, written to stdout for
 * journald/docker to pick up. It is a different thing from run logs, which go
 * to the control plane and belong to the operator — mixing the two would put
 * the worker's retry chatter into the audit-facing record of what a job did.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

export interface Logger {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export function createLogger(level: LogLevel, name = 'worker'): Logger {
  const emit = (at: LogLevel, message: string) => {
    if (RANK[at] < RANK[level]) return;
    const line = `${new Date().toISOString()} ${at.toUpperCase().padEnd(5)} [${name}] ${message}`;
    if (at === 'error') console.error(line);
    else if (at === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
