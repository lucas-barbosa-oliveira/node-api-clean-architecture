import type { Actor } from '../../domain/auth/actor.ts'
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../domain/error/index.ts'
import type { AuthMethod } from '../../domain/model/session.ts'
import type { User, UserRole } from '../../domain/model/user.ts'
import { mfaCodeSchema, parseWith, totpCodeSchema } from '../../domain/validator/mfa.validator.ts'
import type { IRecoveryCodes } from '../port/recovery.codes.ts'
import type { ISecretCipher } from '../port/secret.cipher.ts'
import type { ISessionRepository } from '../port/session.repository.ts'
import type { ITotp } from '../port/totp.ts'
import type { IUserRepository } from '../port/user.repository.ts'

export const RECOVERY_CODE_COUNT = 10
const INVALID_CODE = 'Código inválido ou já usado'

export type MfaSetup = { secret: string; otpauthUrl: string; expiresIn: number }
export type MfaStatus = { enabled: boolean; enabledAt?: Date; recoveryCodesRemaining: number; required: boolean }
/** Como o segundo fator foi provado; vira o "amr" da sessão. */
export type MfaProof = { method: 'totp' | 'recovery_code'; amr: AuthMethod[] }

/**
 * Autenticação multifator por TOTP (aplicativo autenticador) com códigos de recuperação.
 *
 * Ciclo de vida: setup (gera o segredo, ainda inativo) -> enable (confirma com um código e recebe os códigos de
 * recuperação) -> o login passa a pedir o código -> disable (com um código) ou reset (administrador).
 */
export class MfaService {
    #users: IUserRepository
    #sessions: ISessionRepository
    #totp: ITotp
    #cipher: ISecretCipher
    #recoveryCodes: IRecoveryCodes
    #issuer: string
    #setupTtlSeconds: number
    #requiredRoles: readonly UserRole[]

    constructor(deps: {
        users: IUserRepository;
        sessions: ISessionRepository;
        totp: ITotp;
        cipher: ISecretCipher;
        recoveryCodes: IRecoveryCodes;
        /** Nome que aparece no aplicativo autenticador. */
        issuer: string;
        setupTtlSeconds?: number;
        /** Papéis que só recebem escopos com MFA (MFA_REQUIRED_ROLES). */
        requiredRoles?: readonly UserRole[];
    }) {
        this.#users = deps.users
        this.#sessions = deps.sessions
        this.#totp = deps.totp
        this.#cipher = deps.cipher
        this.#recoveryCodes = deps.recoveryCodes
        this.#issuer = deps.issuer
        this.#setupTtlSeconds = deps.setupTtlSeconds ?? 600
        this.#requiredRoles = deps.requiredRoles ?? []
    }

    public isRequired(role: UserRole): boolean {
        return this.#requiredRoles.includes(role)
    }

    public async status(actor: Actor): Promise<MfaStatus> {
        const user = await this.#user(actor.userId)
        return {
            enabled: user.mfaEnabled,
            ...(user.mfa?.enabledAt && { enabledAt: user.mfa.enabledAt }),
            recoveryCodesRemaining: user.mfaEnabled ? user.mfa?.recoveryCodeHashes.length ?? 0 : 0,
            required: this.isRequired(user.role),
        }
    }

    /** Gera o segredo (ainda inativo). Chamar de novo antes de confirmar troca o segredo. */
    public async setup(actor: Actor): Promise<MfaSetup> {
        const user = await this.#user(actor.userId)
        if (user.mfaEnabled) {
            throw new ConflictError('O MFA já está ativo. Para trocar o aplicativo, desative e configure de novo')
        }
        const secret = this.#totp.generateSecret()
        user.startMfaSetup(await this.#cipher.encrypt(secret), this.#setupTtlSeconds)
        await this.#users.save(user)
        return {
            secret,
            otpauthUrl: this.#totp.keyUri({ secret, account: user.email, issuer: this.#issuer }),
            expiresIn: this.#setupTtlSeconds,
        }
    }

    /**
     * Confirma a configuração com um código do aplicativo e devolve os códigos de recuperação (mostrados só agora).
     * A sessão atual vira multifator; as outras sessões do usuário, abertas só com senha, são encerradas.
     */
    public async enable(actor: Actor, input: unknown): Promise<{ recoveryCodes: string[] }> {
        const { code } = parseWith(totpCodeSchema, input)
        const user = await this.#user(actor.userId)
        if (user.mfaEnabled) throw new ConflictError('O MFA já está ativo')
        const pending = user.pendingMfaSecret()
        if (!pending) throw new ConflictError('Nenhuma configuração em andamento (ou expirou): chame POST /auth/mfa/setup')

        const step = this.#totp.verify(await this.#cipher.decrypt(pending), code)
        if (step === null) throw invalidCode('Código não confere: confira o relógio do celular e tente o código atual')

        const { codes, hashes } = this.#recoveryCodes.generate(RECOVERY_CODE_COUNT)
        user.enableMfa({ recoveryCodeHashes: hashes, usedStep: step })
        await this.#users.save(user)
        await this.#elevateAndCloseOthers(actor)
        return { recoveryCodes: codes }
    }

    /** Desliga o MFA. Exige um código (do aplicativo ou de recuperação): um token roubado não basta. */
    public async disable(actor: Actor, input: unknown): Promise<void> {
        const { code } = parseWith(mfaCodeSchema, input)
        const user = await this.#user(actor.userId)
        if (!user.mfaEnabled) throw new ConflictError('O MFA não está ativo')
        if (!(await this.verifyCode(user, code))) throw invalidCode()
        user.disableMfa()
        await this.#users.save(user)
    }

    /** Novos códigos de recuperação (os anteriores deixam de valer). Exige o código do aplicativo. */
    public async regenerateRecoveryCodes(actor: Actor, input: unknown): Promise<{ recoveryCodes: string[] }> {
        const { code } = parseWith(totpCodeSchema, input)
        const user = await this.#user(actor.userId)
        if (!user.mfaEnabled) throw new ConflictError('O MFA não está ativo')
        if ((await this.verifyCode(user, code, { allowRecoveryCode: false }))?.method !== 'totp') throw invalidCode()
        const { codes, hashes } = this.#recoveryCodes.generate(RECOVERY_CODE_COUNT)
        user.replaceRecoveryCodes(hashes)
        await this.#users.save(user)
        return { recoveryCodes: codes }
    }

    /** Administrador: desliga o MFA de um usuário (perdeu o celular e os códigos) e encerra as sessões dele. */
    public async reset(userId: string): Promise<void> {
        const user = await this.#users.findById(userId)
        if (!user) throw new NotFoundError('Usuário não encontrado')
        if (!user.mfa) throw new ConflictError('O usuário não tem MFA configurado')
        user.disableMfa()
        await this.#users.save(user)
        await this.#sessions.revokeAllByUser(userId, 'mfa_reset')
    }

    /**
     * Confere o segundo fator: código TOTP ou de recuperação. Cada código vale uma vez (o TOTP pelo passo de tempo, o de
     * recuperação é removido). Retorna como foi provado, ou null.
     */
    public async verifyCode(
        user: User,
        code: string,
        options: { allowRecoveryCode?: boolean } = {},
    ): Promise<MfaProof | null> {
        const sealed = user.mfa?.secret
        if (!user.mfaEnabled || !sealed) return null

        const recoveryHash = this.#recoveryCodes.hash(code)
        if (recoveryHash) {
            if (options.allowRecoveryCode === false) return null
            if (!(await this.#users.consumeRecoveryCode(user.id, recoveryHash))) return null
            if (user.mfa) user.mfa.recoveryCodeHashes = user.mfa.recoveryCodeHashes.filter(hash => hash !== recoveryHash)
            return { method: 'recovery_code', amr: ['pwd', 'mfa'] }
        }

        const step = this.#totp.verify(await this.#cipher.decrypt(sealed), code)
        if (step === null || !(await this.#users.consumeTotpStep(user.id, step))) return null
        if (user.mfa) user.mfa.lastUsedStep = step // mantém o objeto coerente com o banco para um save em seguida
        await this.#rotateCipherIfStale(user, sealed)
        return { method: 'totp', amr: ['pwd', 'otp', 'mfa'] }
    }

    async #elevateAndCloseOthers(actor: Actor): Promise<void> {
        const sessions = await this.#sessions.findActiveByUser(actor.userId)
        for (const session of sessions) {
            if (session.id === actor.sessionId) session.elevate(['otp', 'mfa'])
            else session.revoke('mfa_enabled')
            await this.#sessions.save(session)
        }
    }

    /**
     * Segredo cifrado com uma chave antiga (rotação de MFA_ENCRYPTION_KEY, nova versão no Vault Transit ou migração
     * de local para Transit): cifra de novo com a atual. Falhar aqui não impede o login.
     */
    async #rotateCipherIfStale(user: User, sealed: string): Promise<void> {
        const refreshed = await this.#cipher.refresh(sealed).catch(() => null)
        if (!refreshed || !user.mfa) return
        user.mfa.secret = refreshed
        await this.#users.save(user)
    }

    async #user(id: string): Promise<User> {
        const user = await this.#users.findById(id)
        // o token é válido, mas o usuário sumiu: trata como sessão inválida
        if (!user) throw new UnauthorizedError('Sessão encerrada. Faça login novamente')
        return user
    }
}

function invalidCode(message = INVALID_CODE): ValidationError {
    return new ValidationError(message, [{ path: ['code'], message, code: 'invalid_mfa_code' }])
}
