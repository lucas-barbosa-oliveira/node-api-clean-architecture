import { context, propagation } from '@opentelemetry/api'
import type { IntegrationEvent } from '../../application/port/event.bus.ts'

/** Um evento guardado no outbox, como o relay o enxerga. */
export type OutboxRecord = {
    id: string;
    exchange: string;
    routingKey: string;
    event: IntegrationEvent;
    traceContext: Record<string, string>;
    attempts: number;
    createdAt: Date;
}

/** Lado do relay: pegar pendentes (com trava, para várias instâncias não enviarem o mesmo), marcar enviado ou reagendar. */
export interface IOutboxStore {
    /** Reserva até `limit` eventos pendentes por `lockMs` (outra instância não os pega nesse período). */
    claim(limit: number, lockMs: number): Promise<OutboxRecord[]>;
    markSent(id: string): Promise<void>;
    reschedule(id: string, availableAt: Date, error: string): Promise<void>;
    stats(): Promise<{ pending: number; oldestCreatedAt?: Date }>;
}

/** Captura o trace atual (W3C traceparent) para o relay publicar como continuação de quem gerou o evento. */
export function captureTraceContext(): Record<string, string> {
    const carrier: Record<string, string> = {}
    propagation.inject(context.active(), carrier)
    return carrier
}
