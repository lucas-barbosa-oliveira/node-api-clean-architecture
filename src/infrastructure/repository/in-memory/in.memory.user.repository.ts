import type { IUserRepository } from '../../../application/port/user.repository.ts'
import type { ListQuery, Page } from '../../../application/query/list.query.ts'
import { ConflictError } from '../../../domain/error/index.ts'
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
        const existing = [...this.#docs.values()].find(doc => doc.email === user.email && doc._id !== user.id)
        if (existing) throw new ConflictError('E-mail já cadastrado')
        this.#docs.set(user.id, structuredClone(this.#mapper.modelToModelEntity(user)))
    }

    // sem await entre a leitura e a escrita: atômico no event loop
    public async consumeTotpStep(userId: string, step: number): Promise<boolean> {
        const mfa = this.#docs.get(userId)?.mfa
        if (!mfa?.enabledAt || (mfa.lastUsedStep !== undefined && mfa.lastUsedStep >= step)) return false
        mfa.lastUsedStep = step
        return true
    }

    public async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
        const mfa = this.#docs.get(userId)?.mfa
        const index = mfa?.recoveryCodeHashes.indexOf(codeHash) ?? -1
        if (!mfa || index < 0) return false
        mfa.recoveryCodeHashes.splice(index, 1)
        return true
    }
}
