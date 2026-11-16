import { ConflictError, NotFoundError } from '../../domain/error/index.ts'
import { User } from '../../domain/model/user.ts'
import { validateCreateUser } from '../../domain/validator/user.validator.ts'
import type { IUserRepository } from '../port/user.repository.ts'

export class UserService {
    #repo: IUserRepository

    constructor(repo: IUserRepository) {
        this.#repo = repo
    }

    public async create(input: unknown): Promise<User> {
        const data = validateCreateUser(input)
        if (await this.#repo.findByEmail(data.email)) throw new ConflictError('E-mail já cadastrado')
        const user = User.create(data)
        await this.#repo.save(user)
        return user
    }

    public async getById(id: string): Promise<User> {
        const user = await this.#repo.findById(id)
        if (!user) throw new NotFoundError('Usuário não encontrado')
        return user
    }
}
