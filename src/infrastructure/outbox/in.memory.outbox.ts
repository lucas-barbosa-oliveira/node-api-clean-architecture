import { randomUUID } from 'node:crypto'
import type { IOutbox, OutboxMessage } from '../../application/port/outbox.ts'
import { captureTraceContext, type IOutboxStore, type OutboxRecord } from './outbox.store.ts'

type Entry = OutboxRecord & { status: 'pending' | 'sent'; availableAt: Date; lockedUntil?: Date; lastError?: string }

/** Outbox em memória (REPOSITORY_DRIVER=memory): mesmo comportamento, sem durabilidade. */
export class InMemoryOutbox implements IOutbox, IOutboxStore {
    #entries = new Map<string, Entry>()
    #onAdd?: () => void

    /** Avisado a cada evento novo (o relay acorda na hora em vez de esperar o próximo ciclo). */
    public onAdd(listener: () => void): void {
        this.#onAdd = listener
    }

    public async add(...messages: OutboxMessage[]): Promise<void> {
        const now = new Date()
        for (const message of messages) {
            const id = randomUUID()
            this.#entries.set(id, {
                id,
                ...structuredClone(message),
                traceContext: captureTraceContext(),
                attempts: 0,
                createdAt: now,
                status: 'pending',
                availableAt: now,
            })
        }
        this.#onAdd?.()
    }

    public async claim(limit: number, lockMs: number): Promise<OutboxRecord[]> {
        const now = Date.now()
        const ready = [...this.#entries.values()]
            .filter(e => e.status === 'pending' && e.availableAt.getTime() <= now && (e.lockedUntil?.getTime() ?? 0) < now)
            .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, limit)
        for (const entry of ready) entry.lockedUntil = new Date(now + lockMs)
        return ready.map(({ status: _s, availableAt: _a, lockedUntil: _l, lastError: _e, ...record }) => structuredClone(record))
    }

    public async markSent(id: string): Promise<void> {
        const entry = this.#entries.get(id)
        if (entry) this.#entries.delete(id)
    }

    public async reschedule(id: string, availableAt: Date, error: string): Promise<void> {
        const entry = this.#entries.get(id)
        if (!entry) return
        entry.attempts++
        entry.availableAt = availableAt
        entry.lockedUntil = undefined
        entry.lastError = error
    }

    public async stats(): Promise<{ pending: number; oldestCreatedAt?: Date }> {
        const pending = [...this.#entries.values()].filter(e => e.status === 'pending')
        const oldest = pending.reduce<Date | undefined>((min, e) => (!min || e.createdAt < min ? e.createdAt : min), undefined)
        return { pending: pending.length, oldestCreatedAt: oldest }
    }
}
