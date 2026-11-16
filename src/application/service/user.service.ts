import { hasScope, type Actor } from '../../domain/auth/actor.ts'
import { SCOPES } from '../../domain/auth/scopes.ts'
import { ConflictError, NotFoundError } from '../../domain/error/index.ts'
import { User } from '../../domain/model/user.ts'
import { normalizeEmail } from '../../domain/utils/normalize.ts'
import { validateCreateUser } from '../../domain/validator/user.validator.ts'
import type { IPasswordHasher } from '../port/password.hasher.ts'
import type { IUserRepository } from '../port/user.repository.ts'

export class UserService {
    #repo: IUserRepository
    #hasher: IPasswordHasher

    constructor(repo: IUserRepository, hasher: IPasswordHasher) {
        this.#repo = repo
        this.#hasher = hasher
    }

    /** Cadastra um gestor ou cliente (quem pode chamar é decidido pelo escopo users:create da rota). */
    public async create(input: unknown): Promise<User> {
        const { password, ...data } = validateCreateUser(input)
        if (await this.#repo.findByEmail(data.email)) throw new ConflictError('E-mail já cadastrado')
        const user = User.create({ ...data, passwordHash: await this.#hasher.hash(password) })
        await this.#repo.save(user)
        return user
    }

    /**
     * Sem users:read:any, o usuário só enxerga o próprio cadastro.
     * Para os demais ids a resposta é 404 (e não 403), para não revelar quais ids existem.
     */
    public async getById(actor: Actor, id: string): Promise<User> {
        const canReadAny = hasScope(actor, SCOPES.usersReadAny)
        const user = canReadAny || id === actor.userId ? await this.#repo.findById(id) : null
        if (!user) throw new NotFoundError('Usuário não encontrado')
        return user
    }

    /** Clientes disponíveis para associar a um job. */
    public listClients(): Promise<User[]> {
        return this.#repo.findByRole('client')
    }

    /** Cria o administrador inicial se ainda não existir (idempotente; chamado na inicialização). */
    public async ensureAdmin(data: { name: string; email: string; password: string }): Promise<void> {
        const email = normalizeEmail(data.email)
        if (await this.#repo.findByEmail(email)) return
        const admin = User.create({
            name: data.name,
            email,
            role: 'admin',
            passwordHash: await this.#hasher.hash(data.password),
        })
        try {
            await this.#repo.save(admin)
        } catch (err) {
            // outra instância criou o admin ao mesmo tempo
            if (!(err instanceof ConflictError)) throw err
        }
    }
}
