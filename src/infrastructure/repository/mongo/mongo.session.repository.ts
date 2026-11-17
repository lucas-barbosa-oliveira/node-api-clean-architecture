import type { Model } from 'mongoose'
import type { ISessionRepository } from '../../../application/port/session.repository.ts'
import type { Session, SessionRevokeReason } from '../../../domain/model/session.ts'
import type { ISessionModel } from '../../database/schema/index.ts'
import { SessionMapper } from '../../mapper/session.mapper.ts'
import { BaseMongoRepository } from '../base/base.repository.ts'

const active = (now: Date) => ({ revokedAt: { $exists: false }, expiresAt: { $gt: now } })

export class MongoSessionRepository extends BaseMongoRepository<Session, ISessionModel> implements ISessionRepository {
    constructor(model: Model<ISessionModel>) {
        super(model, new SessionMapper())
    }

    public save(session: Session): Promise<void> {
        return this.upsert(session)
    }

    public findActiveByUser(userId: string): Promise<Session[]> {
        return this.find({ userId, ...active(new Date()) }, { sort: { createdAt: -1 } })
    }

    /** updateOne com o hash esperado no filtro: só um refresh concorrente consegue trocar o token. */
    public rotateRefreshToken(id: string, expectedHash: string, newHash: string): Promise<boolean> {
        return this.run(async () => {
            const now = new Date()
            const res = await this.model.updateOne(
                { _id: id, refreshTokenHash: expectedHash, ...active(now) },
                { $set: { refreshTokenHash: newHash, lastUsedAt: now, updatedAt: now } },
            )
            return res.modifiedCount === 1
        })
    }

    public revokeAllByUser(userId: string, reason: SessionRevokeReason): Promise<number> {
        return this.run(async () => {
            const now = new Date()
            const res = await this.model.updateMany(
                { userId, ...active(now) },
                { $set: { revokedAt: now, revokedReason: reason, updatedAt: now } },
            )
            return res.modifiedCount
        })
    }

    public deleteEndedBefore(date: Date): Promise<number> {
        return this.deleteMany({ $or: [{ expiresAt: { $lt: date } }, { revokedAt: { $lt: date } }] })
    }
}
