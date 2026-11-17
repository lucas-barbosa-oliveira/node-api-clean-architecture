import type { ILogger } from '../application/port/logger.ts'
import { ConsoleLogger } from '../infrastructure/logger/console.logger.ts'
import type { Env } from './env.ts'

export function buildLogger(env: Pick<Env, 'APP_NAME' | 'LOG_LEVEL' | 'LOG_FORMAT'>): ILogger {
    return new ConsoleLogger({ label: env.APP_NAME, level: env.LOG_LEVEL, format: env.LOG_FORMAT })
}
