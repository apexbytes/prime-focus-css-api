import { createLogger, format, transports, type Logger } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { env, isProduction, isTest, SERVICE_NAME } from '../../config/index.js';
import { getContext } from '../../common/context/request-context.js';
import { redactFormat } from './redact.js';

/** Pulls the ambient request id / actor into every line logged during a request. */
const withRequestContext = format((info) => {
  const context = getContext();
  if (!context) return info;

  // Mutated, not spread: see the note in redact.ts about Winston's Symbol keys.
  info.requestId = context.requestId;
  if (context.actorId) {
    info.actorId = context.actorId;
    info.actorType = context.actorType;
  }
  return info;
});

/** Log fields arrive as `unknown`; render them without risking '[object Object]'. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

const developmentFormat = format.printf((info) => {
  const { level, message, timestamp, requestId, module, stack, ...rest } = info as Record<
    string,
    unknown
  >;
  const scope = [module, requestId]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  const extras = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  const trace = typeof stack === 'string' ? `\n${stack}` : '';
  return `${asText(timestamp)} ${asText(level)}${scope ? ` [${scope}]` : ''}: ${asText(message)}${extras}${trace}`;
});

const fileTransports = env.LOG_TO_FILE
  ? [
      new DailyRotateFile({
        dirname: env.LOG_DIR,
        filename: `${SERVICE_NAME}-%DATE%.log`,
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '30d',
        zippedArchive: true,
      }),
      new DailyRotateFile({
        level: 'error',
        dirname: env.LOG_DIR,
        filename: `${SERVICE_NAME}-error-%DATE%.log`,
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '90d',
        zippedArchive: true,
      }),
    ]
  : [];

export const logger: Logger = createLogger({
  level: env.LOG_LEVEL,
  silent: isTest && env.LOG_LEVEL !== 'debug',
  defaultMeta: { service: SERVICE_NAME, env: env.NODE_ENV },
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    withRequestContext(),
    redactFormat(),
    isProduction ? format.json() : format.combine(format.colorize(), developmentFormat),
  ),
  transports: [new transports.Console({ handleExceptions: false }), ...fileTransports],
  exitOnError: false,
});

/**
 * Per-module logger. Every module should own one so log lines are attributable
 * without repeating the module name at each call site.
 */
export function createModuleLogger(moduleName: string): Logger {
  return logger.child({ module: moduleName });
}

export type { Logger };
