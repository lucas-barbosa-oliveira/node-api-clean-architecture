import { calculateJwkThumbprint, exportJWK, jwtVerify, SignJWT } from 'jose'
import { randomUUID } from 'node:crypto'
import type { ITokenService, IssuedToken } from '../../application/port/token.service.ts'
import type { Actor } from '../../domain/auth/actor.ts'
import { UnauthorizedError } from '../../domain/error/index.ts'
import { PRINCIPAL_ROLES, type PrincipalRole } from '../../domain/auth/scopes.ts'
import type { SigningKeys } from './signing.keys.ts'

const ALGORITHM = 'RS256'

export type JwtConfig = SigningKeys & {
    /** Claim "iss". O Kong usa este valor para achar a chave pública que valida o token. */
    issuer: string;
    /** Claim "aud": para qual API o token foi emitido. */
    audience: string;
    expiresInSeconds: number;
}

/** Emite e valida JWTs assinados com RS256 (só quem tem a chave privada emite; qualquer um valida com a pública). */
export class JwtTokenService implements ITokenService {
    #config: JwtConfig
    #kid?: Promise<string>

    constructor(config: JwtConfig) {
        this.#config = config
    }

    public async issue(actor: Actor, options: { expiresInSeconds?: number } = {}): Promise<IssuedToken> {
        const { privateKey, issuer, audience } = this.#config
        const expiresInSeconds = options.expiresInSeconds ?? this.#config.expiresInSeconds
        const now = Math.floor(Date.now() / 1000)
        const claims = {
            role: actor.role,
            scope: actor.scopes.join(' '),
            ...(actor.sessionId && { sid: actor.sessionId }),
            ...(actor.clientId && { cid: actor.clientId }),
            // RFC 8176: como o usuário se autenticou (outros serviços podem exigir "mfa" em operações sensíveis)
            ...(actor.amr && { amr: [...actor.amr] }),
            ...(actor.mfaEnrollmentRequired && { mfa_enrollment_required: true }),
        }
        const accessToken = await new SignJWT(claims)
            .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT', kid: await this.#keyId() })
            .setSubject(actor.userId)
            .setIssuer(issuer)
            .setAudience(audience)
            .setIssuedAt(now)
            .setExpirationTime(now + expiresInSeconds)
            .setJti(randomUUID())
            .sign(privateKey)
        return { accessToken, expiresIn: expiresInSeconds }
    }

    public async verify(token: string): Promise<Actor> {
        const { publicKey, issuer, audience } = this.#config
        let payload
        try {
            ({ payload } = await jwtVerify(token, publicKey, { issuer, audience, algorithms: [ALGORITHM] }))
        } catch {
            throw new UnauthorizedError('Token inválido ou expirado')
        }
        const { sub, role, scope, sid, cid, amr, mfa_enrollment_required: mfaEnrollment } = payload
        if (typeof sub !== 'string' || typeof scope !== 'string' || !PRINCIPAL_ROLES.includes(role as PrincipalRole)) {
            throw new UnauthorizedError('Token inválido ou expirado')
        }
        return {
            userId: sub,
            role: role as PrincipalRole,
            scopes: scope.split(' ').filter(Boolean),
            ...(typeof sid === 'string' && { sessionId: sid }),
            ...(typeof cid === 'string' && { clientId: cid }),
            ...(Array.isArray(amr) && { amr: amr.filter((method): method is string => typeof method === 'string') }),
            ...(mfaEnrollment === true && { mfaEnrollmentRequired: true }),
        }
    }

    public async publicJwks(): Promise<{ keys: object[] }> {
        const jwk = await exportJWK(this.#config.publicKey)
        return { keys: [{ ...jwk, kid: await this.#keyId(), alg: ALGORITHM, use: 'sig' }] }
    }

    /** kid = thumbprint da chave pública: muda sozinho quando a chave é trocada. */
    #keyId(): Promise<string> {
        this.#kid ??= exportJWK(this.#config.publicKey).then(jwk => calculateJwkThumbprint(jwk))
        return this.#kid
    }
}
