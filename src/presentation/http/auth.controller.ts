import type { Request, Response } from 'express'
import { isMfaChallenge, type AuthService, type LoginResult, type TokenPair } from '../../application/service/auth.service.ts'
import { getActor } from './auth.middleware.ts'

/** Nomes no padrão OAuth 2.0 (RFC 6749). Tokens nunca vão para cache. */
function sendTokens(res: Response, pair: TokenPair): void {
    res.set('Cache-Control', 'no-store').json({
        access_token: pair.accessToken,
        token_type: pair.tokenType,
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        refresh_expires_in: pair.refreshExpiresIn,
        ...(pair.mfaEnrollmentRequired && { mfa_enrollment_required: true }),
    })
}

/** Login de quem tem MFA: em vez dos tokens, o mfa_token da segunda etapa (POST /auth/mfa/verify). */
function sendLogin(res: Response, result: LoginResult): void {
    if (!isMfaChallenge(result)) return sendTokens(res, result)
    res.set('Cache-Control', 'no-store').json({
        mfa_required: true,
        mfa_token: result.mfaToken,
        mfa_methods: result.methods,
        expires_in: result.expiresIn,
    })
}

const clientInfo = (req: Request) => ({ userAgent: req.get('user-agent'), ip: req.ip })

export function authController(service: AuthService) {
    return {
        login: async (req: Request, res: Response) => {
            sendLogin(res, await service.login(req.body, clientInfo(req)))
        },
        verifyMfa: async (req: Request, res: Response) => {
            sendTokens(res, await service.verifyMfa(req.body, clientInfo(req)))
        },
        refresh: async (req: Request, res: Response) => {
            sendTokens(res, await service.refresh(req.body))
        },
        logout: async (_req: Request, res: Response) => {
            await service.logout(getActor(res))
            res.status(204).end()
        },
        logoutAll: async (_req: Request, res: Response) => {
            res.json({ revoked: await service.logoutAll(getActor(res)) })
        },
        listSessions: async (_req: Request, res: Response) => {
            const actor = getActor(res)
            const sessions = await service.listSessions(actor)
            res.json(sessions.map(session => ({ ...session.toJSON(), current: session.id === actor.sessionId })))
        },
        revokeSession: async (req: Request, res: Response) => {
            await service.revokeSession(getActor(res), String(req.params.id))
            res.status(204).end()
        },
        revokeUserSessions: async (req: Request, res: Response) => {
            res.json({ revoked: await service.revokeUserSessions(String(req.params.id)) })
        },
        jwks: async (_req: Request, res: Response) => {
            res.json(await service.publicJwks())
        },
    }
}
