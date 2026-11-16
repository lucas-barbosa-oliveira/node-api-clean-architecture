import { User } from '../../domain/model/user.ts'
import type { IUserModel } from '../database/schema/index.ts'
import { BaseMapper } from './entity.mapper.ts'

export class UserMapper extends BaseMapper<User, IUserModel> {
    public modelToModelEntity(user: User): IUserModel {
        return {
            _id: user.id,
            name: user.name,
            email: user.email,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        }
    }

    public jsonToModel(json: IUserModel): User {
        return new User({
            id: json._id,
            name: json.name,
            email: json.email,
            createdAt: new Date(json.createdAt),
            updatedAt: new Date(json.updatedAt),
        })
    }
}
