import express from 'express'
import type { Container } from '../di/container.ts'
import { authController } from '../presentation/http/auth.controller.ts'
import { authGuards } from '../presentation/http/auth.middleware.ts'
import { authRoutes } from '../presentation/http/auth.routes.ts'
import { errorHandler } from '../presentation/http/error.handler.ts'
import { jobController } from '../presentation/http/job.controller.ts'
import { jobRoutes } from '../presentation/http/job.routes.ts'
import { userController } from '../presentation/http/user.controller.ts'
import { userRoutes } from '../presentation/http/user.routes.ts'

/** Monta o app Express sem subir o servidor (os testes com supertest usam esta função). */
export function createApp(container: Container) {
    const app = express()
    app.disable('x-powered-by')
    app.use(express.json({ limit: '100kb' }))
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' })
    })
    const guards = authGuards(container.authService)
    app.use(authRoutes(authController(container.authService)))
    app.use(userRoutes(userController(container.userService), guards))
    app.use(jobRoutes(jobController(container.jobService), guards))
    app.use(errorHandler)
    return app
}
