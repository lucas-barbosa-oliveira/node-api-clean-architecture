import type { Model } from 'mongoose'
import type { IUserRepository } from '../../../application/port/user.repository.ts'
import type { ListQuery, Page } from '../../../application/query/list.query.ts'
import { ConflictError } from '../../../domain/error/index.ts'
import type { User } from '../../../domain/model/user.ts'
import type { IUserModel } from '../../database/schema/index.ts'
import { UserMapper } from '../../mapper/user.mapper.ts'
import { BaseMongoRepository } from '../base/base.repository.ts'

export class MongoUserRepository extends BaseMongoRepository<User, IUserModel> implements IUserRepository {
    constructor(model: Model<IUserModel>) {
        super(model, new UserMapper())
    }

    public findByEmail(email: string): Promise<User | null> {
        return this.findOne({ email })
    }

    public list(query: ListQuery): Promise<Page<User>> {
        return this.findPage(query)
    }

    public save(user: User): Promise<void> {
        return this.upsert(user)
    }

    /** O filtro só casa se o passo for posterior ao último aceito: dois usos do mesmo código, só um passa. */
    public consumeTotpStep(userId: string, step: number): Promise<boolean> {
        return this.run(async () => {
            const res = await this.model.updateOne(
                { _id: userId, 'mfa.enabledAt': { $exists: true }, 'mfa.lastUsedStep': { $not: { $gte: step } } },
                { $set: { 'mfa.lastUsedStep': step } },
            )
            return res.modifiedCount === 1
        })
    }

    public consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
        return this.run(async () => {
            const res = await this.model.updateOne(
                { _id: userId, 'mfa.recoveryCodeHashes': codeHash },
                { $pull: { 'mfa.recoveryCodeHashes': codeHash } },
            )
            return res.modifiedCount === 1
        })
    }

    protected mongoDBErrorListener(err: unknown): Error {
        const mapped = super.mongoDBErrorListener(err)
        return mapped instanceof ConflictError ? new ConflictError('E-mail já cadastrado') : mapped
    }
}
