import { Router } from 'express'
import { SCOPES } from '../../domain/auth/scopes.ts'
import type { AuthGuards } from './auth.middleware.ts'
import type { mfaController } from './mfa.controller.ts'

/**
 * MFA do próprio usuário: basta estar autenticado (inclusive com o token sem escopos de quem precisa ativar o MFA).
 * A segunda etapa do login (POST /auth/mfa/verify) é pública e fica em auth.routes.ts.
 */
export function mfaRoutes(controller: ReturnType<typeof mfaController>, { guard }: AuthGuards): Router {
    const router = Router()
    router.get('/auth/mfa', guard(), controller.status)
    router.post('/auth/mfa/setup', guard(), controller.setup)
    router.post('/auth/mfa/enable', guard(), controller.enable)
    router.post('/auth/mfa/disable', guard(), controller.disable)
    router.post('/auth/mfa/recovery-codes', guard(), controller.regenerateRecoveryCodes)
    // administrador: usuário perdeu o celular e os códigos de recuperação
    router.delete('/users/:id/mfa', guard(SCOPES.mfaResetAny), controller.reset)
    return router
}
