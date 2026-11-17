import type { ErrorRequestHandler } from 'express'
import type { ILogger } from '../../application/port/logger.ts'
import { AppError, ValidationError } from '../../domain/error/index.ts'

// Mapeamento código de erro -> status HTTP. O domínio não sabe que HTTP existe.
const statusByCode: Record<string, number> = {
    VALIDATION: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
}

export type ErrorHandlerOptions = {
    /** Reconhece erros de dependência fora do ar (decidido na infraestrutura, que conhece os drivers). */
    isUnavailable?: (err: unknown) => boolean;
    /** Sugestão de espera, em segundos, para o cliente tentar de novo. */
    retryAfterSeconds?: number;
}

export const errorHandler = (
    logger: ILogger,
    options: ErrorHandlerOptions = {},
): ErrorRequestHandler => (err, req, res, _next) => {
    if (err instanceof AppError) {
        const body: Record<string, unknown> = { code: err.code, message: err.message }
        if (err instanceof ValidationError) body.issues = err.issues
        if (err.code === 'UNAUTHORIZED') res.set('WWW-Authenticate', 'Bearer')
        res.status(statusByCode[err.code] ?? 400).json(body)
        return
    }
    // erros do próprio Express (ex.: JSON malformado)
    if (typeof err?.status === 'number' && err.status < 500) {
        res.status(err.status).json({ code: 'BAD_REQUEST', message: err.message })
        return
    }
    // banco, fila ou barramento fora do ar: 503 + Retry-After (o cliente pode tentar de novo; não é um bug)
    if (options.isUnavailable?.(err)) {
        logger.warn(`Dependência indisponível em ${req.method} ${req.originalUrl}: ${err instanceof Error ? err.message : err}`, {
            request_id: res.locals.requestId,
        })
        res.status(503).set('Retry-After', String(options.retryAfterSeconds ?? 5)).json({
            code: 'UNAVAILABLE',
            message: 'Serviço temporariamente indisponível. Tente novamente em instantes',
        })
        return
    }
    logger.error(`Erro não tratado em ${req.method} ${req.originalUrl}`, { err, request_id: res.locals.requestId })
    res.status(500).json({ code: 'INTERNAL', message: 'Erro interno' })
}
