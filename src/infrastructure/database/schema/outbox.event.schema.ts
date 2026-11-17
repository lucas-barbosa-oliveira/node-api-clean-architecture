import mongoose from 'mongoose'

export interface IOutboxEventModel {
  _id: string;
  exchange: string;
  routingKey: string;
  eventName: string;
  /** Evento serializado: o corpo das requisições auditadas pode ter chaves que o Mongo não aceita ($, ponto). */
  payload: string;
  /** Contexto do trace (W3C traceparent) de quem gravou, para o relay continuar o mesmo trace. */
  traceContext?: Record<string, string>;
  status: 'pending' | 'sent';
  attempts: number;
  availableAt: Date;
  lockedUntil?: Date;
  lastError?: string;
  createdAt: Date;
  sentAt?: Date;
}

export const outboxEventSchema = new mongoose.Schema<IOutboxEventModel>(
    {
        _id: { type: String, required: true },
        exchange: { type: String, required: true },
        routingKey: { type: String, required: true },
        eventName: { type: String, required: true },
        payload: { type: String, required: true },
        traceContext: { type: mongoose.Schema.Types.Mixed },
        status: { type: String, enum: ['pending', 'sent'], required: true },
        attempts: { type: Number, required: true },
        availableAt: { type: Date, required: true },
        lockedUntil: { type: Date },
        lastError: { type: String },
        createdAt: { type: Date, required: true },
        sentAt: { type: Date },
    },
    { collection: 'outbox_events', versionKey: false },
)

// o relay busca os pendentes mais antigos já liberados para envio
outboxEventSchema.index({ status: 1, availableAt: 1, createdAt: 1 })
// enviados ficam 7 dias (para investigação) e são apagados pelo próprio Mongo
outboxEventSchema.index({ sentAt: 1 }, { expireAfterSeconds: 7 * 86_400 })
