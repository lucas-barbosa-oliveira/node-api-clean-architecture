import type { IUserRepository } from '../../../application/port/user.repository.ts'
import type { ListQuery, Page } from '../../../application/query/list.query.ts'
import type { User } from '../../../domain/model/user.ts'
import type { IUserModel } from '../../database/schema/index.ts'
import { UserMapper } from '../../mapper/user.mapper.ts'
import { queryDocs } from './in.memory.query.ts'

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

    public async list(query: ListQuery): Promise<Page<User>> {
        const { items, total } = queryDocs([...this.#docs.values()].map(doc => structuredClone(doc)), query)
        return { items: this.#mapper.transform(items), total }
    }

    public async save(user: User): Promise<void> {
        this.#docs.set(user.id, structuredClone(this.#mapper.modelToModelEntity(user)))
    }
}
