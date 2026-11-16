import { Router } from 'express'
import { SCOPES } from '../../domain/auth/scopes.ts'
import type { AuthGuards } from './auth.middleware.ts'
import type { userController } from './user.controller.ts'

export function userRoutes(controller: ReturnType<typeof userController>, { guard }: AuthGuards): Router {
    const router = Router()
    router.post('/users', guard(SCOPES.usersCreate), controller.create)
    router.get('/users/me', guard(SCOPES.usersRead), controller.me) // antes de /users/:id
    router.get('/users/:id', guard(SCOPES.usersRead), controller.getById)
    router.get('/clients', guard(SCOPES.clientsRead), controller.listClients)
    return router
}
