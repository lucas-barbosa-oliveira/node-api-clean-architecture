import { Entity, type EntityProps } from './entity.ts'

/** Tentativas de código por desafio: depois disso, só com novo login (senha de novo). */
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5

export type MfaChallengeProps = EntityProps & {
    userId: string;
    /** Hash do segredo do mfa_token. O token em si só existe na resposta do login. */
    tokenHash: string;
    expiresAt: Date;
    attempts: number;
    usedAt?: Date;
    userAgent?: string;
    ip?: string;
}

/**
 * Segunda etapa do login: a senha já foi conferida e falta o código do aplicativo (ou de recuperação).
 * Vale por poucos minutos, para poucas tentativas e uma única vez.
 */
export class MfaChallenge extends Entity {
    public readonly userId: string
    public readonly tokenHash: string
    public readonly expiresAt: Date
    public attempts: number
    public usedAt?: Date
    public readonly userAgent?: string
    public readonly ip?: string

    constructor(props: MfaChallengeProps) {
        super(props)
        this.userId = props.userId
        this.tokenHash = props.tokenHash
        this.expiresAt = props.expiresAt
        this.attempts = props.attempts
        this.usedAt = props.usedAt
        this.userAgent = props.userAgent
        this.ip = props.ip
    }

    public static issue(data: {
        id: string;
        userId: string;
        tokenHash: string;
        ttlSeconds: number;
        userAgent?: string;
        ip?: string;
    }): MfaChallenge {
        const { ttlSeconds, ...rest } = data
        return new MfaChallenge({ ...rest, attempts: 0, expiresAt: new Date(Date.now() + ttlSeconds * 1000) })
    }

    public get attemptsLeft(): number {
        return Math.max(0, MFA_CHALLENGE_MAX_ATTEMPTS - this.attempts)
    }
}
