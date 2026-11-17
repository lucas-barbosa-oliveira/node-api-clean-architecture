import { randomUUID } from 'node:crypto'
import type { Model } from 'mongoose'
import type { IntegrationEvent } from '../../application/port/event.bus.ts'
import type { IOutbox, OutboxMessage } from '../../application/port/outbox.ts'
import type { IOutboxEventModel } from '../database/schema/index.ts'
import { captureTraceContext, type IOutboxStore, type OutboxRecord } from './outbox.store.ts'

/**
 * Outbox na coleção outbox_events. add() roda dentro da transação corrente (o Mongoose repassa a sessão sozinho,
 * via transactionAsyncLocalStorage), então o evento só é gravado se a mudança de dados também for.
 */
export class MongoOutbox implements IOutbox, IOutboxStore {
    #model: Model<IOutboxEventModel>
    #onAdd?: () => void

    constructor(model: Model<IOutboxEventModel>) {
        this.#model = model
    }

    public onAdd(listener: () => void): void {
        this.#onAdd = listener
    }

    public async add(...messages: OutboxMessage[]): Promise<void> {
        const now = new Date()
        const traceContext = captureTraceContext()
        await this.#model.insertMany(messages.map(message => ({
            _id: randomUUID(),
            exchange: message.exchange,
            routingKey: message.routingKey,
            eventName: message.event.event_name,
            payload: JSON.stringify(message.event),
            traceContext,
            status: 'pending',
            attempts: 0,
            availableAt: now,
            createdAt: now,
        })))
        this.#onAdd?.()
    }

    public async claim(limit: number, lockMs: number): Promise<OutboxRecord[]> {
        const records: OutboxRecord[] = []
        for (let i = 0; i < limit; i++) {
            const now = new Date()
            // findOneAndUpdate é atômico: duas instâncias nunca reservam o mesmo evento
            const doc = await this.#model.findOneAndUpdate(
                {
                    status: 'pending',
                    availableAt: { $lte: now },
                    $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }],
                },
                { $set: { lockedUntil: new Date(now.getTime() + lockMs) } },
                { sort: { availableAt: 1, createdAt: 1 }, returnDocument: 'after' },
            ).lean()
            if (!doc) break
            records.push({
                id: doc._id,
                exchange: doc.exchange,
                routingKey: doc.routingKey,
                event: JSON.parse(doc.payload) as IntegrationEvent,
                traceContext: doc.traceContext ?? {},
                attempts: doc.attempts,
                createdAt: doc.createdAt,
            })
        }
        return records
    }

    public async markSent(id: string): Promise<void> {
        await this.#model.updateOne({ _id: id }, { $set: { status: 'sent', sentAt: new Date() }, $unset: { lockedUntil: 1 } })
    }

    public async reschedule(id: string, availableAt: Date, error: string): Promise<void> {
        await this.#model.updateOne(
            { _id: id },
            { $set: { availableAt, lastError: error.slice(0, 500) }, $inc: { attempts: 1 }, $unset: { lockedUntil: 1 } },
        )
    }

    public async stats(): Promise<{ pending: number; oldestCreatedAt?: Date }> {
        const [pending, oldest] = await Promise.all([
            this.#model.countDocuments({ status: 'pending' }),
            this.#model.findOne({ status: 'pending' }, { createdAt: 1 }).sort({ createdAt: 1 }).lean(),
        ])
        return { pending, oldestCreatedAt: oldest?.createdAt }
    }
}
