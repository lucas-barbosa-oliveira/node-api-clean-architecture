import { randomUUID } from 'node:crypto'
import type { IEventBus, IntegrationEvent } from '../port/event.bus.ts'
import { silentLogger, type ILogger } from '../port/logger.ts'
import { limitSize, redact } from './redact.ts'

export const AUDIT_EXCHANGE = 'audit'
export const AUDIT_ROUTING_KEY = 'audit.request'
export const AUDIT_EVENT_NAME = 'RequestAuditEvent'

/** O que aconteceu em uma requisição: quem fez, o que pediu, o que recebeu e quando. */
export type AuditRecord = {
    requestId: string;
    actor: { id: string; role: string; sessionId?: string; clientId?: string } | null;
    request: {
        method: string;
        path: string;
        /** Padrão da rota, ex.: /jobs/:id (agrupa as chamadas da mesma operação). */
        route?: string;
        params: Record<string, string | string[]>;
        query: Record<string, unknown>;
        body: unknown;
        ip?: string;
        userAgent?: string;
    };
    response: { statusCode: number; body: unknown };
    startedAt: Date;
    finishedAt: Date;
}

/**
 * Publica no barramento um RequestAuditEvent por operação, para o serviço de auditoria.
 * Segredos (senhas, tokens, códigos de pareamento) são trocados por [REDACTED] antes de sair da aplicação.
 * Nunca afeta a requisição: falhas viram log.
 */
export class AuditService {
    #bus: IEventBus
    #service: string
    #maxBodyBytes: number
    #log: ILogger

    constructor(deps: { bus: IEventBus; service: string; maxBodyBytes?: number; logger?: ILogger }) {
        this.#bus = deps.bus
        this.#service = deps.service
        this.#maxBodyBytes = deps.maxBodyBytes ?? 16_384
        this.#log = deps.logger ?? silentLogger
    }

    public record(record: AuditRecord): void {
        this.#bus.publish(AUDIT_EXCHANGE, AUDIT_ROUTING_KEY, this.toEvent(record)).catch(err => {
            this.#log.error(`Falha ao publicar a auditoria de ${record.request.method} ${record.request.path}`, { err })
        })
    }

    public toEvent(record: AuditRecord): IntegrationEvent {
        const { request, response } = record
        // "code" é segredo no pareamento (pedido e resposta), mas em respostas de erro é o código do erro
        const responseSecrets = response.statusCode < 400 ? ['code'] : []
        return {
            event_name: AUDIT_EVENT_NAME,
            timestamp: new Date().toISOString(),
            audit: {
                id: randomUUID(), // permite ao consumidor descartar duplicatas (reenvio após queda do barramento)
                service: this.#service,
                request_id: record.requestId,
                actor: record.actor && {
                    id: record.actor.id,
                    role: record.actor.role,
                    ...(record.actor.sessionId && { session_id: record.actor.sessionId }),
                    ...(record.actor.clientId && { client_id: record.actor.clientId }),
                },
                request: {
                    method: request.method,
                    path: request.path,
                    ...(request.route && { route: request.route }),
                    params: request.params,
                    query: redact(request.query, ['code']),
                    body: limitSize(redact(request.body, ['code']), this.#maxBodyBytes),
                    ip: request.ip,
                    user_agent: request.userAgent,
                },
                response: {
                    status_code: response.statusCode,
                    body: limitSize(redact(response.body, responseSecrets), this.#maxBodyBytes),
                },
                started_at: record.startedAt.toISOString(),
                finished_at: record.finishedAt.toISOString(),
                duration_ms: record.finishedAt.getTime() - record.startedAt.getTime(),
            },
        }
    }
}
