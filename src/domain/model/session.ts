import { Entity, type EntityProps } from './entity.ts'

export const SESSION_REVOKE_REASONS = [
    'logout',
    'logout_all',
    'revoked_by_user',
    'revoked_by_admin',
    'refresh_token_reused',
    'user_not_found',
    /** O MFA foi ativado em outra sessão: as abertas só com senha caem. */
    'mfa_enabled',
    /** Um administrador redefiniu o MFA do usuário (ex.: celular perdido). */
    'mfa_reset',
] as const
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number]

/**
 * Como o usuário se autenticou (claim "amr", RFC 8176): "pwd" (senha), "otp" (código TOTP) e "mfa" (mais de um fator).
 * Login com código de recuperação: ["pwd", "mfa"].
 */
export const AUTH_METHODS = ['pwd', 'otp', 'mfa'] as const
export type AuthMethod = (typeof AUTH_METHODS)[number]

export type SessionProps = EntityProps & {
    userId: string;
    /** Hash do refresh token atual. O token em si nunca é guardado. */
    refreshTokenHash: string;
    /** Validade absoluta da sessão: o refresh token não renova esse prazo. */
    expiresAt: Date;
    lastUsedAt?: Date;
    revokedAt?: Date;
    revokedReason?: SessionRevokeReason;
    userAgent?: string;
    ip?: string;
    /** Métodos usados no login (ausente em sessões antigas: equivale a ["pwd"]). */
    amr?: AuthMethod[];
}

/**
 * Uma sessão de login. O access token carrega o id da sessão (claim "sid"),
 * então revogar a sessão invalida na hora o access token e o refresh token dela.
 */
export class Session extends Entity {
    public readonly userId: string
    public refreshTokenHash: string
    public readonly expiresAt: Date
    public lastUsedAt?: Date
    public revokedAt?: Date
    public revokedReason?: SessionRevokeReason
    public readonly userAgent?: string
    public readonly ip?: string
    public amr: AuthMethod[]

    constructor(props: SessionProps) {
        super(props)
        this.userId = props.userId
        this.refreshTokenHash = props.refreshTokenHash
        this.expiresAt = props.expiresAt
        this.lastUsedAt = props.lastUsedAt
        this.revokedAt = props.revokedAt
        this.revokedReason = props.revokedReason
        this.userAgent = props.userAgent
        this.ip = props.ip
        this.amr = props.amr ?? ['pwd']
    }

    public static start(data: {
        id: string;
        userId: string;
        refreshTokenHash: string;
        ttlSeconds: number;
        userAgent?: string;
        ip?: string;
        amr?: AuthMethod[];
    }): Session {
        const { ttlSeconds, ...rest } = data
        return new Session({ ...rest, expiresAt: new Date(Date.now() + ttlSeconds * 1000) })
    }

    public isActive(now = new Date()): boolean {
        return !this.revokedAt && this.expiresAt > now
    }

    /** A sessão passou por um segundo fator (login com MFA ou confirmação do MFA nesta sessão). */
    public get multiFactor(): boolean {
        return this.amr.includes('mfa')
    }

    /** O usuário provou o segundo fator nesta sessão (ao ativar o MFA): ela passa a valer como multifator. */
    public elevate(amr: AuthMethod[]): void {
        this.amr = [...new Set([...this.amr, ...amr])]
        this.touch()
    }

    public revoke(reason: SessionRevokeReason): void {
        if (this.revokedAt) return
        this.revokedAt = new Date()
        this.revokedReason = reason
        this.touch()
    }

    /** O hash do refresh token não sai da aplicação. */
    public toJSON(): Omit<SessionProps, 'refreshTokenHash'> {
        const { refreshTokenHash: _omit, ...rest } = this
        return rest
    }
}
