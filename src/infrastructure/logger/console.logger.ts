import { trace } from '@opentelemetry/api'
import type { ILogger, LogLevel, LogMeta } from '../../application/port/logger.ts'

const SEVERITY: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
const COLORS: Record<Exclude<LogLevel, 'silent'>, string> = {
    error: '\x1b[31m',
    warn: '\x1b[33m',
    info: '\x1b[32m',
    debug: '\x1b[34m',
}
const RESET = '\x1b[0m'

export type ConsoleLoggerOptions = {
    /** Identifica a aplicação em cada linha, ex.: api-clean-architecture. */
    label: string;
    level: LogLevel;
    /** text: legível no terminal; json: uma linha JSON por log (para agregadores como Loki, ELK, CloudWatch). */
    format: 'text' | 'json';
    /** Cores no nível (padrão: só quando a saída é um terminal; NO_COLOR desliga, FORCE_COLOR liga). */
    colors?: boolean;
    /** Destino das linhas (padrão: stdout; error e warn vão para stderr). */
    write?: (line: string, level: LogLevel) => void;
}

/**
 * Logger sem dependências externas.
 *
 *   text:  api-clean-architecture @ 2026-11-17T13:23:19.504Z info: [mongo] Conexão estabelecida
 *   json:  {"timestamp":"...","level":"info","label":"...","component":"mongo","message":"Conexão estabelecida"}
 */
export class ConsoleLogger implements ILogger {
    #options: Required<ConsoleLoggerOptions>
    #component?: string

    constructor(options: ConsoleLoggerOptions, component?: string) {
        this.#options = {
            ...options,
            colors: options.colors ?? defaultColors(),
            write: options.write ?? defaultWrite,
        }
        this.#component = component
    }

    public error(message: string, meta?: LogMeta): void {
        this.#log('error', message, meta)
    }

    public warn(message: string, meta?: LogMeta): void {
        this.#log('warn', message, meta)
    }

    public info(message: string, meta?: LogMeta): void {
        this.#log('info', message, meta)
    }

    public debug(message: string, meta?: LogMeta): void {
        this.#log('debug', message, meta)
    }

    public child(component: string): ILogger {
        return new ConsoleLogger(this.#options, component)
    }

    #log(level: Exclude<LogLevel, 'silent'>, message: string, meta?: LogMeta): void {
        if (SEVERITY[level] > SEVERITY[this.#options.level]) return
        const timestamp = new Date().toISOString()
        const { err, ...rest } = meta ?? {}
        // dentro de uma requisição ou mensagem rastreada, o log aponta para o trace (busca direta no Jaeger)
        const span = trace.getActiveSpan()?.spanContext()
        const traceIds = span && span.traceId !== '00000000000000000000000000000000'
            ? { trace_id: span.traceId, span_id: span.spanId }
            : undefined
        const error = err instanceof Error ? err : undefined

        if (this.#options.format === 'json') {
            this.#options.write(JSON.stringify({
                timestamp,
                level,
                label: this.#options.label,
                ...(this.#component && { component: this.#component }),
                message,
                ...traceIds,
                ...rest,
                ...(err !== undefined && { err: error ? { message: error.message, stack: error.stack } : err }),
            }), level)
            return
        }

        const levelText = this.#options.colors ? `${COLORS[level]}${level}${RESET}` : level
        const component = this.#component ? `[${this.#component}] ` : ''
        const extra = Object.keys(rest).length > 0 ? ` ${safeJson(rest)}` : ''
        const traceText = traceIds ? ` trace_id=${traceIds.trace_id}` : ''
        let line = `${this.#options.label} @ ${timestamp} ${levelText}: ${component}${message}${extra}${traceText}`
        if (error) line += `\n${error.stack ?? error.message}`
        else if (err !== undefined) line += ` ${safeJson(err)}`
        this.#options.write(line, level)
    }
}

function defaultWrite(line: string, level: LogLevel): void {
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
    else process.stdout.write(line + '\n')
}

function defaultColors(): boolean {
    if (process.env.NO_COLOR) return false
    if (process.env.FORCE_COLOR) return true
    return Boolean(process.stdout.isTTY)
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}
