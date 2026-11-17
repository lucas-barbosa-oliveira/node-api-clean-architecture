import type { ILogger } from '../../application/port/logger.ts'

const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH'])

/**
 * Handler de 'error' para filas e workers do BullMQ (sem ele, o BullMQ imprime o erro cru com console.error).
 * Erros de conexão já aparecem nos logs do componente redis (queda, tentativas, retorno): aqui ficam no debug.
 */
export function onQueueError(log: ILogger, context: string) {
    return (err: Error & { code?: string }): void => {
        const isConnection = CONNECTION_ERRORS.has(err.code ?? '') || /Connection is closed/i.test(err.message)
        if (isConnection) log.debug(`${context}: ${err.message}`)
        else log.error(`${context}: ${err.message}`, { err })
    }
}
