import { Router } from 'express'
import type { authController } from './auth.controller.ts'

/** Rotas públicas: login e chaves públicas para validar os tokens. */
export function authRoutes(controller: ReturnType<typeof authController>): Router {
    const router = Router()
    router.post('/auth/login', controller.login)
    router.get('/.well-known/jwks.json', controller.jwks)
    return router
}
