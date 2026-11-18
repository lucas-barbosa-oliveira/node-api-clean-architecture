import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { hasScope, type Actor } from '../../domain/auth/actor.ts'
import { ROLE_SCOPES, SCOPES } from '../../domain/auth/scopes.ts'
import { NotFoundError, UnauthorizedError, ValidationError } from '../../domain/error/index.ts'
import { MfaChallenge } from '../../domain/model/mfa.challenge.ts'
import { Session, type AuthMethod } from '../../domain/model/session.ts'
import type { User } from '../../domain/model/user.ts'
import { mfaVerifySchema, parseWith } from '../../domain/validator/mfa.validator.ts'
import { validateLogin } from '../../domain/validator/user.validator.ts'
import type { IMfaChallengeRepository } from '../port/mfa.challenge.repository.ts'
import type { IPasswordHasher } from '../port/password.hasher.ts'
import type { IRefreshTokenCodec } from '../port/refresh.token.codec.ts'
import type { ISessionRepository } from '../port/session.repository.ts'
import type { ITokenService } from '../port/token.service.ts'
import type { IUserRepository } from '../port/user.repository.ts'
import type { MfaService } from './mfa.service.ts'

export type TokenPair = {
    tokenType: 'Bearer';
    accessToken: string;
    expiresIn: number;
    refreshToken: string;
    refreshExpiresIn: number;
    /** O papel exige MFA e o usuário não ativou: o token não tem escopos (só serve para configurar o MFA). */
    mfaEnrollmentRequired?: boolean;
}

/** Primeira etapa do login de quem tem MFA: falta o código. */
export type MfaChallengeResult = {
    mfaRequired: true;
    mfaToken: string;
    methods: ('totp' | 'recovery_code')[];
    expiresIn: number;
}

export type LoginResult = TokenPair | MfaChallengeResult

export const isMfaChallenge = (result: LoginResult): result is MfaChallengeResult => 'mfaRequired' in result

export type ClientInfo = { userAgent?: string; ip?: string }

export const refreshSchema = z.object({ refresh_token: z.string().min(1).max(512) })

const INVALID_REFRESH = 'Refresh token inválido, expirado ou revogado'
const INVALID_CHALLENGE = 'Etapa de MFA inválida, expirada ou sem tentativas restantes. Faça login novamente'

export class AuthService {
    #users: IUserRepository
    #sessions: ISessionRepository
    #hasher: IPasswordHasher
    #tokens: ITokenService
    #refreshTokens: IRefreshTokenCodec
    #refreshTtlSeconds: number
    #dummyHash?: Promise<string>
    #isDeviceActive?: (deviceId: string, clientId: string | undefined) => Promise<boolean>
    #mfa: MfaService
    #challenges: IMfaChallengeRepository
    #challengeTtlSeconds: number

    constructor(deps: {
        users: IUserRepository;
        sessions: ISessionRepository;
        hasher: IPasswordHasher;
        tokens: ITokenService;
        refreshTokens: IRefreshTokenCodec;
        refreshTtlSeconds: number;
        /** Consulta se um dispositivo continua ativo (DeviceService.isActive). Sem ela, tokens de dispositivo são recusados. */
        isDeviceActive?: (deviceId: string, clientId: string | undefined) => Promise<boolean>;
        mfa: MfaService;
        mfaChallenges: IMfaChallengeRepository;
        /** Tempo para digitar o código depois da senha (MFA_CHALLENGE_TTL_SECONDS). */
        mfaChallengeTtlSeconds?: number;
    }) {
        this.#users = deps.users
        this.#sessions = deps.sessions
        this.#hasher = deps.hasher
        this.#tokens = deps.tokens
        this.#refreshTokens = deps.refreshTokens
        this.#refreshTtlSeconds = deps.refreshTtlSeconds
        this.#isDeviceActive = deps.isDeviceActive
        this.#mfa = deps.mfa
        this.#challenges = deps.mfaChallenges
        this.#challengeTtlSeconds = deps.mfaChallengeTtlSeconds ?? 300
    }

    /**
     * Troca e-mail e senha por um par de tokens e abre uma sessão.
     * Com MFA ativo, não abre sessão ainda: devolve um mfa_token para a segunda etapa (POST /auth/mfa/verify).
     */
    public async login(input: unknown, client: ClientInfo = {}): Promise<LoginResult> {
        const { email, password } = validateLogin(input)
        const user = await this.#users.findByEmail(email)

        // e-mail inexistente também calcula um hash: o tempo de resposta não revela quais e-mails existem
        this.#dummyHash ??= this.#hasher.hash('senha-ficticia-para-tempo-constante')
        const valid = await this.#hasher.verify(password, user?.passwordHash ?? await this.#dummyHash)
        if (!user || !valid) throw new UnauthorizedError('E-mail ou senha inválidos')

        if (user.mfaEnabled) return this.#challenge(user, client)
        return this.#startSession(user, ['pwd'], client)
    }

    /**
     * Segunda etapa do login: o mfa_token da primeira etapa e o código do aplicativo (ou um de recuperação).
     * Cada desafio aceita poucas tentativas (MFA_CHALLENGE_MAX_ATTEMPTS) e vale uma vez.
     */
    public async verifyMfa(input: unknown, client: ClientInfo = {}): Promise<TokenPair> {
        const { mfa_token: token, code } = parseWith(mfaVerifySchema, input)
        const presented = this.#refreshTokens.parse(token)
        if (!presented) throw new UnauthorizedError(INVALID_CHALLENGE)

        // a tentativa é contada antes de conferir o código: requisições em paralelo não furam o limite
        const challenge = await this.#challenges.reserveAttempt(presented.sessionId, presented.secretHash)
        if (!challenge) throw new UnauthorizedError(INVALID_CHALLENGE)
        const user = await this.#users.findById(challenge.userId)
        if (!user) throw new UnauthorizedError(INVALID_CHALLENGE)

        const proof = await this.#mfa.verifyCode(user, code)
        if (!proof) {
            const left = challenge.attemptsLeft
            throw new UnauthorizedError(left > 0
                ? `Código inválido ou já usado (${left} tentativa(s) restante(s))`
                : INVALID_CHALLENGE)
        }
        if (!(await this.#challenges.consume(challenge.id))) throw new UnauthorizedError(INVALID_CHALLENGE)
        return this.#startSession(user, proof.amr, client)
    }

    async #challenge(user: User, client: ClientInfo): Promise<MfaChallengeResult> {
        const id = randomUUID()
        // mesmo formato opaco do refresh token ("<id>.<segredo>"), só o hash do segredo é guardado
        const token = this.#refreshTokens.create(id)
        await this.#challenges.save(MfaChallenge.issue({
            id,
            userId: user.id,
            tokenHash: token.hash,
            ttlSeconds: this.#challengeTtlSeconds,
            userAgent: client.userAgent?.slice(0, 300),
            ip: client.ip,
        }))
        const methods: MfaChallengeResult['methods'] = ['totp']
        if ((user.mfa?.recoveryCodeHashes.length ?? 0) > 0) methods.push('recovery_code')
        return { mfaRequired: true, mfaToken: token.token, methods, expiresIn: this.#challengeTtlSeconds }
    }

    async #startSession(user: User, amr: AuthMethod[], client: ClientInfo): Promise<TokenPair> {
        const sessionId = randomUUID()
        const refresh = this.#refreshTokens.create(sessionId)
        const session = Session.start({
            id: sessionId,
            userId: user.id,
            refreshTokenHash: refresh.hash,
            ttlSeconds: this.#refreshTtlSeconds,
            userAgent: client.userAgent?.slice(0, 300),
            ip: client.ip,
            amr,
        })
        await this.#sessions.save(session)
        return this.#pair(user, session, refresh.token)
    }

    /**
     * Rotação: cada refresh token vale uma única vez e é trocado por um novo.
     * Reapresentar um token já usado indica vazamento (alguém tem uma cópia): a sessão inteira é revogada.
     */
    public async refresh(input: unknown): Promise<TokenPair> {
        const parsed = refreshSchema.safeParse(input)
        if (!parsed.success) throw new ValidationError('Dados inválidos', parsed.error.issues)

        const presented = this.#refreshTokens.parse(parsed.data.refresh_token)
        if (!presented) throw new UnauthorizedError(INVALID_REFRESH)

        const session = await this.#sessions.findById(presented.sessionId)
        if (!session?.isActive()) throw new UnauthorizedError(INVALID_REFRESH)

        if (!this.#refreshTokens.matches(presented.secretHash, session.refreshTokenHash)) {
            await this.#revoke(session, 'refresh_token_reused')
            throw new UnauthorizedError(INVALID_REFRESH)
        }

        const user = await this.#users.findById(session.userId)
        if (!user) {
            await this.#revoke(session, 'user_not_found')
            throw new UnauthorizedError(INVALID_REFRESH)
        }

        const next = this.#refreshTokens.create(session.id)
        // troca atômica: dois refreshes simultâneos com o mesmo token não geram duas sessões válidas
        if (!(await this.#sessions.rotateRefreshToken(session.id, session.refreshTokenHash, next.hash))) {
            await this.#revoke(session, 'refresh_token_reused')
            throw new UnauthorizedError(INVALID_REFRESH)
        }
        // o papel pode ter mudado desde o login: os escopos saem do cadastro atual
        return this.#pair(user, session, next.token)
    }

    /**
     * Valida o access token e confere se a sessão dele continua ativa (revogação tem efeito imediato).
     * Token de dispositivo não tem sessão: vale enquanto o dispositivo estiver ativo.
     */
    public async authenticate(token: string): Promise<Actor> {
        const actor = await this.#tokens.verify(token)
        if (actor.role === 'device') {
            if (!this.#isDeviceActive || !(await this.#isDeviceActive(actor.userId, actor.clientId))) {
                throw new UnauthorizedError('Dispositivo revogado ou não encontrado. Pareie novamente')
            }
            return actor
        }
        const session = actor.sessionId ? await this.#sessions.findById(actor.sessionId) : null
        if (!session?.isActive() || session.userId !== actor.userId) {
            throw new UnauthorizedError('Sessão encerrada. Faça login novamente')
        }
        return actor
    }

    /** Encerra a sessão do token usado na requisição. */
    public async logout(actor: Actor): Promise<void> {
        const session = actor.sessionId ? await this.#sessions.findById(actor.sessionId) : null
        if (session) await this.#revoke(session, 'logout')
    }

    /** Encerra todas as sessões do usuário (ex.: "sair de todos os dispositivos"). */
    public logoutAll(actor: Actor): Promise<number> {
        return this.#sessions.revokeAllByUser(actor.userId, 'logout_all')
    }

    public listSessions(actor: Actor): Promise<Session[]> {
        return this.#sessions.findActiveByUser(actor.userId)
    }

    /** O usuário revoga uma sessão dele; com sessions:revoke:any, qualquer sessão. Sessão alheia responde 404. */
    public async revokeSession(actor: Actor, sessionId: string): Promise<void> {
        const canRevokeAny = hasScope(actor, SCOPES.sessionsRevokeAny)
        const session = await this.#sessions.findById(sessionId)
        if (!session || (!canRevokeAny && session.userId !== actor.userId)) throw new NotFoundError('Sessão não encontrada')
        await this.#revoke(session, session.userId === actor.userId ? 'revoked_by_user' : 'revoked_by_admin')
    }

    /** Administrador encerra todas as sessões de um usuário (ex.: conta comprometida). */
    public async revokeUserSessions(userId: string): Promise<number> {
        if (!(await this.#users.findById(userId))) throw new NotFoundError('Usuário não encontrado')
        return this.#sessions.revokeAllByUser(userId, 'revoked_by_admin')
    }

    public purgeSessionsEndedBefore(date: Date): Promise<number> {
        return this.#sessions.deleteEndedBefore(date)
    }

    public publicJwks(): Promise<{ keys: object[] }> {
        return this.#tokens.publicJwks()
    }

    async #revoke(session: Session, reason: Parameters<Session['revoke']>[0]): Promise<void> {
        session.revoke(reason)
        await this.#sessions.save(session)
    }

    /**
     * Os escopos saem do papel, com uma exceção: papel que exige MFA (MFA_REQUIRED_ROLES) em sessão sem segundo fator
     * recebe um token sem escopos, que só serve para configurar o MFA (e gerenciar as sessões).
     */
    async #pair(user: User, session: Session, refreshToken: string): Promise<TokenPair> {
        const enrollmentRequired = this.#mfa.isRequired(user.role) && !session.multiFactor
        const access = await this.#tokens.issue({
            userId: user.id,
            role: user.role,
            scopes: enrollmentRequired ? [] : ROLE_SCOPES[user.role],
            sessionId: session.id,
            amr: session.amr,
            ...(enrollmentRequired && { mfaEnrollmentRequired: true }),
        })
        return {
            ...(enrollmentRequired && { mfaEnrollmentRequired: true }),
            tokenType: 'Bearer',
            accessToken: access.accessToken,
            expiresIn: access.expiresIn,
            refreshToken,
            refreshExpiresIn: Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)),
        }
    }
}
