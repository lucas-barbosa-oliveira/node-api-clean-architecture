import express from 'express'
import type { Container } from '../di/container.ts'
import { errorHandler } from '../presentation/http/error.handler.ts'
import { jobController } from '../presentation/http/job.controller.ts'
import { jobRoutes } from '../presentation/http/job.routes.ts'
import { userController } from '../presentation/http/user.controller.ts'
import { userRoutes } from '../presentation/http/user.routes.ts'

/** Monta o app Express sem subir o servidor (os testes com supertest usam esta função). */
export function createApp(container: Container) {
    const app = express()
    app.use(express.json())
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' })
    })
    app.use(userRoutes(userController(container.userService)))
    app.use(jobRoutes(jobController(container.jobService)))
    app.use(errorHandler)
    return app
}
