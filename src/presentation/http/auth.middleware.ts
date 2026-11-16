import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AuthService } from '../../application/service/auth.service.ts'
import type { Actor } from '../../domain/auth/actor.ts'
import type { Scope } from '../../domain/auth/scopes.ts'
import { ForbiddenError, UnauthorizedError } from '../../domain/error/index.ts'

export type AuthGuards = ReturnType<typeof authGuards>

/**
 * O token é validado aqui também, mesmo já tendo passado pelo Kong (zero trust):
 * se alguém chegar à API sem passar pelo gateway, continua sem acesso.
 */
export function authGuards(authService: AuthService) {
    /** 401 se o token estiver ausente ou inválido; em caso de sucesso guarda o Actor em res.locals. */
    const authenticate: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
        const [scheme, token] = (req.headers.authorization ?? '').split(' ')
        if (scheme?.toLowerCase() !== 'bearer' || !token) {
            throw new UnauthorizedError('Informe o token: Authorization: Bearer <token>')
        }
        res.locals.actor = await authService.authenticate(token)
        next()
    }

    /** 403 se o token não tiver todos os escopos exigidos pela rota. */
    const requireScopes = (...required: Scope[]): RequestHandler => (_req, res, next) => {
        const actor = getActor(res)
        const missing = required.filter(scope => !actor.scopes.includes(scope))
        if (missing.length > 0) throw new ForbiddenError(`Escopo necessário: ${missing.join(' ')}`)
        next()
    }

    /** Atalho para usar nas rotas: autentica e exige os escopos. */
    const guard = (...required: Scope[]): RequestHandler[] => [authenticate, requireScopes(...required)]

    return { authenticate, requireScopes, guard }
}

export function getActor(res: Response): Actor {
    const actor = res.locals.actor as Actor | undefined
    if (!actor) throw new UnauthorizedError()
    return actor
}
