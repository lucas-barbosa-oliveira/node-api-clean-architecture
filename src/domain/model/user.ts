import { Entity, type EntityProps } from './entity.ts'

export const USER_ROLES = ['admin', 'manager', 'client'] as const
export type UserRole = (typeof USER_ROLES)[number]

/**
 * Autenticação multifator (TOTP, RFC 6238) do usuário. Nada daqui sai da aplicação: o segredo fica cifrado e os
 * códigos de recuperação, só como hash.
 */
export type UserMfa = {
    /** Segredo TOTP cifrado (presente com o MFA ativo). */
    secret?: string;
    enabledAt?: Date;
    /** Hash de cada código de recuperação ainda não usado (cada um vale uma vez). */
    recoveryCodeHashes: string[];
    /** Último passo de 30 s aceito: o mesmo código TOTP não vale duas vezes. */
    lastUsedStep?: number;
    /** Configuração em andamento: segredo cifrado aguardando a confirmação com um código do aplicativo. */
    pendingSecret?: string;
    pendingExpiresAt?: Date;
}

export type UserProps = EntityProps & {
    name: string;
    email: string;
    role: UserRole;
    passwordHash: string;
    mfa?: UserMfa;
}

export type UserJson = Omit<UserProps, 'passwordHash' | 'mfa'> & { mfaEnabled: boolean }

export class User extends Entity {
    public readonly name: string
    public readonly email: string
    public readonly role: UserRole
    public readonly passwordHash: string
    public mfa?: UserMfa

    constructor(props: UserProps) {
        super(props)
        this.name = props.name
        this.email = props.email
        this.role = props.role
        this.passwordHash = props.passwordHash
        this.mfa = props.mfa
    }

    public static create(data: { name: string; email: string; role: UserRole; passwordHash: string }): User {
        return new User(data)
    }

    public get mfaEnabled(): boolean {
        return Boolean(this.mfa?.enabledAt && this.mfa.secret)
    }

    /** Segredo da configuração em andamento, se ainda não expirou. */
    public pendingMfaSecret(now = new Date()): string | undefined {
        const { pendingSecret, pendingExpiresAt } = this.mfa ?? {}
        return pendingSecret && pendingExpiresAt && pendingExpiresAt > now ? pendingSecret : undefined
    }

    /** Começa (ou recomeça) a configuração: o MFA só liga depois de confirmado com um código. */
    public startMfaSetup(encryptedSecret: string, ttlSeconds: number): void {
        this.mfa = {
            recoveryCodeHashes: [],
            ...this.mfa,
            pendingSecret: encryptedSecret,
            pendingExpiresAt: new Date(Date.now() + ttlSeconds * 1000),
        }
        this.touch()
    }

    /** Confirma a configuração: o segredo pendente vira o definitivo. */
    public enableMfa(data: { recoveryCodeHashes: string[]; usedStep: number }): void {
        const secret = this.pendingMfaSecret()
        if (!secret) throw new Error('Nenhuma configuração de MFA em andamento')
        this.mfa = {
            secret,
            enabledAt: new Date(),
            recoveryCodeHashes: data.recoveryCodeHashes,
            lastUsedStep: data.usedStep,
        }
        this.touch()
    }

    public replaceRecoveryCodes(hashes: string[]): void {
        if (!this.mfa) return
        this.mfa = { ...this.mfa, recoveryCodeHashes: hashes }
        this.touch()
    }

    public disableMfa(): void {
        if (!this.mfa) return
        this.mfa = undefined
        this.touch()
    }

    /** Usado pelo JSON.stringify (respostas HTTP): hash da senha e dados do MFA nunca saem da aplicação. */
    public toJSON(): UserJson {
        const { passwordHash: _hash, mfa: _mfa, ...rest } = this
        return { ...rest, mfaEnabled: this.mfaEnabled }
    }
}
