import { randomUUID } from 'node:crypto'
import type { IntegrationEvent } from '../port/event.bus.ts'
import { silentLogger, type ILogger } from '../port/logger.ts'
import type { IOutbox } from '../port/outbox.ts'
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
 * Registra um RequestAuditEvent por operação, para o serviço de auditoria. O evento vai para o outbox (gravado no banco)
 * e é publicado pelo relay: uma queda do RabbitMQ, ou um reinício da API, não perde auditoria.
 * Segredos (senhas, tokens, códigos de pareamento) são trocados por [REDACTED] antes de sair da aplicação.
 * Nunca afeta a requisição: falhas viram log.
 */
export class AuditService {
    #outbox: IOutbox
    #service: string
    #maxBodyBytes: number
    #log: ILogger

    constructor(deps: { outbox: IOutbox; service: string; maxBodyBytes?: number; logger?: ILogger }) {
        this.#outbox = deps.outbox
        this.#service = deps.service
        this.#maxBodyBytes = deps.maxBodyBytes ?? 16_384
        this.#log = deps.logger ?? silentLogger
    }

    public record(record: AuditRecord): void {
        const message = { exchange: AUDIT_EXCHANGE, routingKey: AUDIT_ROUTING_KEY, event: this.toEvent(record) }
        this.#outbox.add(message).catch(err => {
            this.#log.error(`Falha ao gravar a auditoria de ${record.request.method} ${record.request.path}`, { err })
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
