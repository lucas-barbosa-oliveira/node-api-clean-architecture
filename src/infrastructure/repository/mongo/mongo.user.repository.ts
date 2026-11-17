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

    public async save(user: User): Promise<void> {
        await this.create(user)
    }

    protected mongoDBErrorListener(err: unknown): Error {
        const mapped = super.mongoDBErrorListener(err)
        return mapped instanceof ConflictError ? new ConflictError('E-mail já cadastrado') : mapped
    }
}
