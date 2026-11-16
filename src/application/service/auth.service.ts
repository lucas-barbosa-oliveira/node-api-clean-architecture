import type { Actor } from '../../domain/auth/actor.ts'
import { ROLE_SCOPES } from '../../domain/auth/scopes.ts'
import { UnauthorizedError } from '../../domain/error/index.ts'
import { validateLogin } from '../../domain/validator/user.validator.ts'
import type { IPasswordHasher } from '../port/password.hasher.ts'
import type { ITokenService, IssuedToken } from '../port/token.service.ts'
import type { IUserRepository } from '../port/user.repository.ts'

export class AuthService {
    #users: IUserRepository
    #hasher: IPasswordHasher
    #tokens: ITokenService
    #dummyHash?: Promise<string>

    constructor(users: IUserRepository, hasher: IPasswordHasher, tokens: ITokenService) {
        this.#users = users
        this.#hasher = hasher
        this.#tokens = tokens
    }

    /** Troca e-mail e senha por um access token com os escopos do papel do usuário. */
    public async login(input: unknown): Promise<IssuedToken & { tokenType: 'Bearer' }> {
        const { email, password } = validateLogin(input)
        const user = await this.#users.findByEmail(email)

        // e-mail inexistente também calcula um hash: o tempo de resposta não revela quais e-mails existem
        this.#dummyHash ??= this.#hasher.hash('senha-ficticia-para-tempo-constante')
        const valid = await this.#hasher.verify(password, user?.passwordHash ?? await this.#dummyHash)
        if (!user || !valid) throw new UnauthorizedError('E-mail ou senha inválidos')

        const token = await this.#tokens.issue({ userId: user.id, role: user.role, scopes: ROLE_SCOPES[user.role] })
        return { ...token, tokenType: 'Bearer' }
    }

    public authenticate(token: string): Promise<Actor> {
        return this.#tokens.verify(token)
    }

    public publicJwks(): Promise<{ keys: object[] }> {
        return this.#tokens.publicJwks()
    }
}
