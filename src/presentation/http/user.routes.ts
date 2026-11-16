import { Router } from 'express'
import type { userController } from './user.controller.ts'

export function userRoutes(controller: ReturnType<typeof userController>): Router {
    const router = Router()
    router.post('/users', controller.create)
    router.get('/users/:id', controller.getById)
    return router
}
