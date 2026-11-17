import type { ISessionRepository } from '../../../application/port/session.repository.ts'
import type { Session, SessionRevokeReason } from '../../../domain/model/session.ts'
import type { ISessionModel } from '../../database/schema/index.ts'
import { SessionMapper } from '../../mapper/session.mapper.ts'

const isActive = (doc: ISessionModel, now: Date) => !doc.revokedAt && doc.expiresAt > now

export class InMemorySessionRepository implements ISessionRepository {
    #docs = new Map<string, ISessionModel>()
    #mapper = new SessionMapper()

    public async save(session: Session): Promise<void> {
        this.#docs.set(session.id, structuredClone(this.#mapper.modelToModelEntity(session)))
    }

    public async findById(id: string): Promise<Session | null> {
        const doc = this.#docs.get(id)
        return this.#mapper.transform(doc && structuredClone(doc))
    }

    public async findActiveByUser(userId: string): Promise<Session[]> {
        const now = new Date()
        const docs = [...this.#docs.values()]
            .filter(doc => doc.userId === userId && isActive(doc, now))
            .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        return this.#mapper.transform(docs.map(doc => structuredClone(doc)))
    }

    // sem await entre a leitura e a escrita: atômico no event loop
    public async rotateRefreshToken(id: string, expectedHash: string, newHash: string): Promise<boolean> {
        const doc = this.#docs.get(id)
        const now = new Date()
        if (!doc || doc.refreshTokenHash !== expectedHash || !isActive(doc, now)) return false
        Object.assign(doc, { refreshTokenHash: newHash, lastUsedAt: now, updatedAt: now })
        return true
    }

    public async revokeAllByUser(userId: string, reason: SessionRevokeReason): Promise<number> {
        const now = new Date()
        let count = 0
        for (const doc of this.#docs.values()) {
            if (doc.userId === userId && isActive(doc, now)) {
                Object.assign(doc, { revokedAt: now, revokedReason: reason, updatedAt: now })
                count++
            }
        }
        return count
    }

    public async deleteEndedBefore(date: Date): Promise<number> {
        let count = 0
        for (const [id, doc] of this.#docs) {
            if (doc.expiresAt < date || (doc.revokedAt && doc.revokedAt < date)) {
                this.#docs.delete(id)
                count++
            }
        }
        return count
    }
}
