import { Router } from 'express'
import { SCOPES } from '../../domain/auth/scopes.ts'
import type { AuthGuards } from './auth.middleware.ts'
import type { deviceController } from './device.controller.ts'

export function deviceRoutes(controller: ReturnType<typeof deviceController>, { guard }: AuthGuards): Router {
    const router = Router()
    router.post('/clients/:clientId/pairing-codes', guard(SCOPES.devicesManage), controller.createPairingCode)
    router.post('/devices/claim', controller.claim) // pública: autenticada pelo código
    router.get('/devices', guard(SCOPES.devicesRead), controller.list)
    router.delete('/devices/:id', guard(SCOPES.devicesManage), controller.revoke)
    return router
}
