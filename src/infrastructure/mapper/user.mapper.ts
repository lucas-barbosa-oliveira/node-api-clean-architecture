import { User, type UserMfa } from '../../domain/model/user.ts'
import type { IUserModel } from '../database/schema/index.ts'
import { BaseMapper } from './entity.mapper.ts'

export class UserMapper extends BaseMapper<User, IUserModel> {
    public modelToModelEntity(user: User): IUserModel {
        return {
            _id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            passwordHash: user.passwordHash,
            ...(user.mfa && { mfa: { ...user.mfa, recoveryCodeHashes: [...user.mfa.recoveryCodeHashes] } }),
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        }
    }

    public jsonToModel(json: IUserModel): User {
        return new User({
            id: json._id,
            name: json.name,
            email: json.email,
            role: json.role,
            passwordHash: json.passwordHash,
            mfa: toMfa(json.mfa),
            createdAt: new Date(json.createdAt),
            updatedAt: new Date(json.updatedAt),
        })
    }
}

const toDate = (value: unknown): Date | undefined =>
    value == null ? undefined : new Date(value as string | number | Date)

function toMfa(mfa: IUserModel['mfa']): UserMfa | undefined {
    if (!mfa) return undefined
    return {
        secret: mfa.secret ?? undefined,
        enabledAt: toDate(mfa.enabledAt),
        recoveryCodeHashes: [...(mfa.recoveryCodeHashes ?? [])],
        lastUsedStep: mfa.lastUsedStep ?? undefined,
        pendingSecret: mfa.pendingSecret ?? undefined,
        pendingExpiresAt: toDate(mfa.pendingExpiresAt),
    }
}
