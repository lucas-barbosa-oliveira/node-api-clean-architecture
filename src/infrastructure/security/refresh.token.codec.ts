import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IRefreshTokenCodec } from '../../application/port/refresh.token.codec.ts'

const SEPARATOR = '.'
const SESSION_ID = /^[0-9a-f-]{36}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/ // 32 bytes em base64url

/**
 * O segredo tem 256 bits aleatórios, então um SHA-256 simples basta para guardá-lo
 * (o scrypt das senhas existe para compensar senhas fracas, o que não é o caso aqui).
 */
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url')

export class RefreshTokenCodec implements IRefreshTokenCodec {
    public create(sessionId: string): { token: string; hash: string } {
        const secret = randomBytes(32).toString('base64url')
        return { token: `${sessionId}${SEPARATOR}${secret}`, hash: sha256(secret) }
    }

    public parse(token: string): { sessionId: string; secretHash: string } | null {
        const [sessionId, secret, ...rest] = token.split(SEPARATOR)
        if (rest.length > 0 || !SESSION_ID.test(sessionId ?? '') || !SECRET.test(secret ?? '')) return null
        return { sessionId, secretHash: sha256(secret) }
    }

    public matches(secretHash: string, storedHash: string): boolean {
        const a = Buffer.from(secretHash)
        const b = Buffer.from(storedHash)
        return a.length === b.length && timingSafeEqual(a, b)
    }
}
