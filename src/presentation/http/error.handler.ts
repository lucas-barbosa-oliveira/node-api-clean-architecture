import type { ErrorRequestHandler } from 'express'
import { AppError, ValidationError } from '../../domain/error/index.ts'

// Mapeamento código de erro -> status HTTP. O domínio não sabe que HTTP existe.
const statusByCode: Record<string, number> = {
    VALIDATION: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
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
    console.error(err)
    res.status(500).json({ code: 'INTERNAL', message: 'Erro interno' })
}
