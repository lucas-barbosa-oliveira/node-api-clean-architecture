import { Router } from 'express'
import type { jobController } from './job.controller.ts'

export function jobRoutes(controller: ReturnType<typeof jobController>): Router {
    const router = Router()
    router.post('/reports', controller.submitReport)
    router.get('/jobs/:id', controller.getById)
    return router
}
