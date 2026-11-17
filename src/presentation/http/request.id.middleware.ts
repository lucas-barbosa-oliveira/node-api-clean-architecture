import { randomUUID } from 'node:crypto'
import type { RequestHandler, Response } from 'express'

export const REQUEST_ID_HEADER = 'X-Request-ID'
const VALID_ID = /^[\w.:-]{1,128}$/

/**
 * Identificador da requisição: o gerado pelo Kong (plugin correlation-id) ou um novo, se a chamada vier direto.
 * Volta no header da resposta e acompanha a auditoria, para cruzar logs do gateway, da API e do serviço de auditoria.
 */
export const requestId: RequestHandler = (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER)
    const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID()
    res.locals.requestId = id
    res.locals.startedAt = new Date()
    res.set(REQUEST_ID_HEADER, id)
    next()
}

export function getRequestId(res: Response): string {
    return (res.locals.requestId as string | undefined) ?? ''
}
