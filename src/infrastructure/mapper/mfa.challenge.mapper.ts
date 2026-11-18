import { MfaChallenge } from '../../domain/model/mfa.challenge.ts'
import type { IMfaChallengeModel } from '../database/schema/index.ts'
import { BaseMapper } from './entity.mapper.ts'

const toDate = (value: unknown): Date | undefined =>
    value == null ? undefined : new Date(value as string | number | Date)

export class MfaChallengeMapper extends BaseMapper<MfaChallenge, IMfaChallengeModel> {
    public modelToModelEntity(challenge: MfaChallenge): IMfaChallengeModel {
        return {
            _id: challenge.id,
            userId: challenge.userId,
            tokenHash: challenge.tokenHash,
            expiresAt: challenge.expiresAt,
            attempts: challenge.attempts,
            usedAt: challenge.usedAt,
            userAgent: challenge.userAgent,
            ip: challenge.ip,
            createdAt: challenge.createdAt,
            updatedAt: challenge.updatedAt,
        }
    }

    public jsonToModel(json: IMfaChallengeModel): MfaChallenge {
        return new MfaChallenge({
            id: json._id,
            userId: json.userId,
            tokenHash: json.tokenHash,
            expiresAt: new Date(json.expiresAt),
            attempts: json.attempts,
            usedAt: toDate(json.usedAt),
            userAgent: json.userAgent,
            ip: json.ip,
            createdAt: new Date(json.createdAt),
            updatedAt: new Date(json.updatedAt),
        })
    }
}
