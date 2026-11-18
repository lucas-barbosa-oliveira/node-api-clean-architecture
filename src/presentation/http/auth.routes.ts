import { Router } from 'express'
import { SCOPES } from '../../domain/auth/scopes.ts'
import type { authController } from './auth.controller.ts'
import type { AuthGuards } from './auth.middleware.ts'

export function authRoutes(controller: ReturnType<typeof authController>, { guard }: AuthGuards): Router {
    const router = Router()
    // públicas
    router.post('/auth/login', controller.login)
    router.post('/auth/refresh', controller.refresh)
    // segunda etapa do login com MFA: o mfa_token da primeira etapa é a credencial
    router.post('/auth/mfa/verify', controller.verifyMfa)
    router.get('/.well-known/jwks.json', controller.jwks)
    // sessões do próprio usuário: basta estar autenticado
    router.post('/auth/logout', guard(), controller.logout)
    router.post('/auth/logout-all', guard(), controller.logoutAll)
    router.get('/auth/sessions', guard(), controller.listSessions)
    router.delete('/auth/sessions/:id', guard(), controller.revokeSession)
    // administrador: derruba todas as sessões de um usuário
    router.delete('/users/:id/sessions', guard(SCOPES.sessionsRevokeAny), controller.revokeUserSessions)
    return router
}
