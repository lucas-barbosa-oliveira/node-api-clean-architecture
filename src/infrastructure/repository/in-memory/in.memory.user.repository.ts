import type { IUserRepository } from '../../../application/port/user.repository.ts'
import type { User, UserRole } from '../../../domain/model/user.ts'
import type { IUserModel } from '../../database/schema/index.ts'
import { UserMapper } from '../../mapper/user.mapper.ts'

/** Guarda documentos (mesmo formato do Mongo) para exercitar o mapper também sem banco. */
export class InMemoryUserRepository implements IUserRepository {
    #docs = new Map<string, IUserModel>()
    #mapper = new UserMapper()

    public async findById(id: string): Promise<User | null> {
        const doc = this.#docs.get(id)
        return this.#mapper.transform(doc && structuredClone(doc))
    }

    public async findByEmail(email: string): Promise<User | null> {
        const doc = [...this.#docs.values()].find(item => item.email === email)
        return this.#mapper.transform(doc && structuredClone(doc))
    }

    public async findByRole(role: UserRole): Promise<User[]> {
        const docs = [...this.#docs.values()].filter(item => item.role === role)
        return this.#mapper.transform(docs.map(item => structuredClone(item)))
    }

    public async save(user: User): Promise<void> {
        this.#docs.set(user.id, structuredClone(this.#mapper.modelToModelEntity(user)))
    }
}
