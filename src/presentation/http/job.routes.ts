import { Router } from 'express'
import { SCOPES } from '../../domain/auth/scopes.ts'
import type { AuthGuards } from './auth.middleware.ts'
import type { jobController } from './job.controller.ts'

export function jobRoutes(controller: ReturnType<typeof jobController>, { guard }: AuthGuards): Router {
    const router = Router()
    router.post('/reports', guard(SCOPES.jobsCreate), controller.submitReport)
    router.get('/jobs', guard(SCOPES.jobsRead), controller.list)
    router.get('/jobs/:id', guard(SCOPES.jobsRead), controller.getById)
    return router
}
