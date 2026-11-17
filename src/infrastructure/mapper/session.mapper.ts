import { Session } from '../../domain/model/session.ts'
import type { ISessionModel } from '../database/schema/index.ts'
import { BaseMapper } from './entity.mapper.ts'

const toDate = (value: unknown): Date | undefined =>
    value == null ? undefined : new Date(value as string | number | Date)

export class SessionMapper extends BaseMapper<Session, ISessionModel> {
    public modelToModelEntity(session: Session): ISessionModel {
        return {
            _id: session.id,
            userId: session.userId,
            refreshTokenHash: session.refreshTokenHash,
            expiresAt: session.expiresAt,
            lastUsedAt: session.lastUsedAt,
            revokedAt: session.revokedAt,
            revokedReason: session.revokedReason,
            userAgent: session.userAgent,
            ip: session.ip,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
        }
    }

    public jsonToModel(json: ISessionModel): Session {
        return new Session({
            id: json._id,
            userId: json.userId,
            refreshTokenHash: json.refreshTokenHash,
            expiresAt: new Date(json.expiresAt),
            lastUsedAt: toDate(json.lastUsedAt),
            revokedAt: toDate(json.revokedAt),
            revokedReason: json.revokedReason,
            userAgent: json.userAgent,
            ip: json.ip,
            createdAt: new Date(json.createdAt),
            updatedAt: new Date(json.updatedAt),
        })
    }
}
