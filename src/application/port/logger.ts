export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** Dados extras do log. Um campo "err" com um Error tem a mensagem e o stack impressos. */
export type LogMeta = Record<string, unknown>

/** Saída de logs da aplicação. As camadas internas dependem só desta interface. */
export interface ILogger {
    error(message: string, meta?: LogMeta): void;
    warn(message: string, meta?: LogMeta): void;
    info(message: string, meta?: LogMeta): void;
    debug(message: string, meta?: LogMeta): void;
    /** Logger de um componente: as mensagens saem com o prefixo [componente]. */
    child(component: string): ILogger;
}

/** Descarta tudo (padrão quando nenhum logger é informado, ex.: testes de unidade). */
export const silentLogger: ILogger = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => silentLogger,
}
