import type { RequestHandler } from 'express'
import type { AuditService } from '../../application/audit/audit.service.ts'
import type { Actor } from '../../domain/auth/actor.ts'
import { getRequestId } from './request.id.middleware.ts'

/**
 * Ao terminar cada requisição, envia para o AuditService a entrada, a resposta, quem fez e quando.
 * Registrado antes das rotas: vê também as respostas de erro (401, 403, 404...) produzidas pelo errorHandler.
 */
export function audit(auditService: AuditService, options: { ignorePaths: readonly string[] }): RequestHandler {
    return (req, res, next) => {
        if (options.ignorePaths.some(prefix => req.path === prefix || req.path.startsWith(prefix + '/'))) return next()

        // guarda o corpo da resposta quando ela é enviada como JSON
        let responseBody: unknown
        const json = res.json.bind(res)
        res.json = body => {
            responseBody = body
            return json(body)
        }

        res.on('finish', () => {
            const actor = res.locals.actor as Actor | undefined
            const route = req.route?.path as string | undefined
            auditService.record({
                requestId: getRequestId(res),
                actor: actor
                    ? { id: actor.userId, role: actor.role, sessionId: actor.sessionId, clientId: actor.clientId }
                    : null,
                request: {
                    method: req.method,
                    path: req.path,
                    route: route ? `${req.baseUrl}${route}` : undefined,
                    params: { ...req.params },
                    query: { ...req.query },
                    body: req.body,
                    ip: req.ip,
                    userAgent: req.get('User-Agent'),
                },
                response: { statusCode: res.statusCode, body: toPlain(responseBody) },
                startedAt: (res.locals.startedAt as Date | undefined) ?? new Date(),
                finishedAt: new Date(),
            })
        })
        next()
    }
}

/** Entidades viram o mesmo JSON que o cliente recebeu (toJSON), sem campos internos. */
function toPlain(body: unknown): unknown {
    return body === undefined ? undefined : JSON.parse(JSON.stringify(body))
}
