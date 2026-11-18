import type { IMfaChallengeRepository } from '../../../application/port/mfa.challenge.repository.ts'
import { MFA_CHALLENGE_MAX_ATTEMPTS, type MfaChallenge } from '../../../domain/model/mfa.challenge.ts'
import type { IMfaChallengeModel } from '../../database/schema/index.ts'
import { MfaChallengeMapper } from '../../mapper/mfa.challenge.mapper.ts'

export class InMemoryMfaChallengeRepository implements IMfaChallengeRepository {
    #docs = new Map<string, IMfaChallengeModel>()
    #mapper = new MfaChallengeMapper()

    public async save(challenge: MfaChallenge): Promise<void> {
        this.#purgeExpired()
        this.#docs.set(challenge.id, structuredClone(this.#mapper.modelToModelEntity(challenge)))
    }

    // sem await entre a leitura e a escrita: atômico no event loop
    public async reserveAttempt(id: string, tokenHash: string): Promise<MfaChallenge | null> {
        const now = new Date()
        const doc = this.#docs.get(id)
        if (!doc || doc.tokenHash !== tokenHash || doc.usedAt || doc.expiresAt <= now) return null
        if (doc.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) return null
        Object.assign(doc, { attempts: doc.attempts + 1, updatedAt: now })
        return this.#mapper.transform(structuredClone(doc))
    }

    public async consume(id: string): Promise<boolean> {
        const doc = this.#docs.get(id)
        if (!doc || doc.usedAt) return false
        Object.assign(doc, { usedAt: new Date(), updatedAt: new Date() })
        return true
    }

    /** No Mongo, o índice TTL faz isso. */
    #purgeExpired(): void {
        const now = Date.now()
        for (const [id, doc] of this.#docs) if (doc.expiresAt.getTime() < now - 3_600_000) this.#docs.delete(id)
    }
}
