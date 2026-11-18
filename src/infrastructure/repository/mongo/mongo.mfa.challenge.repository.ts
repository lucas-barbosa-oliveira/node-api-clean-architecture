import type { Model } from 'mongoose'
import type { IMfaChallengeRepository } from '../../../application/port/mfa.challenge.repository.ts'
import { MFA_CHALLENGE_MAX_ATTEMPTS, type MfaChallenge } from '../../../domain/model/mfa.challenge.ts'
import type { IMfaChallengeModel } from '../../database/schema/index.ts'
import { MfaChallengeMapper } from '../../mapper/mfa.challenge.mapper.ts'
import { BaseMongoRepository } from '../base/base.repository.ts'

export class MongoMfaChallengeRepository
    extends BaseMongoRepository<MfaChallenge, IMfaChallengeModel>
    implements IMfaChallengeRepository {
    constructor(model: Model<IMfaChallengeModel>) {
        super(model, new MfaChallengeMapper())
    }

    public async save(challenge: MfaChallenge): Promise<void> {
        await this.create(challenge)
    }

    /** As condições de validade no filtro e o $inc no mesmo comando: o limite vale mesmo com requisições em paralelo. */
    public reserveAttempt(id: string, tokenHash: string): Promise<MfaChallenge | null> {
        return this.run(async () => {
            const now = new Date()
            const doc = await this.model
                .findOneAndUpdate(
                    {
                        _id: id,
                        tokenHash,
                        usedAt: { $exists: false },
                        expiresAt: { $gt: now },
                        attempts: { $lt: MFA_CHALLENGE_MAX_ATTEMPTS },
                    },
                    { $inc: { attempts: 1 }, $set: { updatedAt: now } },
                    { returnDocument: 'after' },
                )
                .lean()
            return this.mapper.transform(doc as IMfaChallengeModel | null)
        })
    }

    public consume(id: string): Promise<boolean> {
        return this.run(async () => {
            const now = new Date()
            const res = await this.model.updateOne(
                { _id: id, usedAt: { $exists: false } },
                { $set: { usedAt: now, updatedAt: now } },
            )
            return res.modifiedCount === 1
        })
    }
}
