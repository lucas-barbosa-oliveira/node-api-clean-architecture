import type { Request, Response } from 'express'
import type { AuthService } from '../../application/service/auth.service.ts'

export function authController(service: AuthService) {
    return {
        login: async (req: Request, res: Response) => {
            const { accessToken, tokenType, expiresIn } = await service.login(req.body)
            // nomes no padrão OAuth 2.0 (RFC 6749)
            res.set('Cache-Control', 'no-store').json({ access_token: accessToken, token_type: tokenType, expires_in: expiresIn })
        },
        jwks: async (_req: Request, res: Response) => {
            res.json(await service.publicJwks())
        },
    }
}
