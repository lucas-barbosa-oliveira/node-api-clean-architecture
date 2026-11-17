import { Router } from 'express'
import { SCOPES } from '../../domain/auth/scopes.ts'
import type { AuthGuards } from './auth.middleware.ts'
import type { passageController } from './passage.controller.ts'

export function passageRoutes(controller: ReturnType<typeof passageController>, { guard }: AuthGuards): Router {
    const router = Router()
    router.post('/devices/:deviceId/passages', guard(SCOPES.telemetryWrite), controller.ingest)
    router.get('/passages/summary', guard(SCOPES.passagesRead), controller.summary) // antes de rotas com parâmetro
    router.get('/passages', guard(SCOPES.passagesRead), controller.list)
    return router
}
