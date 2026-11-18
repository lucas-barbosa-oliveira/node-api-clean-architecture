import express from 'express'
import type { Container } from '../di/container.ts'
import { accessLog } from '../presentation/http/access.log.middleware.ts'
import { audit } from '../presentation/http/audit.middleware.ts'
import { authController } from '../presentation/http/auth.controller.ts'
import { authGuards } from '../presentation/http/auth.middleware.ts'
import { authRoutes } from '../presentation/http/auth.routes.ts'
import { deviceController } from '../presentation/http/device.controller.ts'
import { deviceRoutes } from '../presentation/http/device.routes.ts'
import { errorHandler } from '../presentation/http/error.handler.ts'
import { healthRoutes } from '../presentation/http/health.routes.ts'
import { jobController } from '../presentation/http/job.controller.ts'
import { jobRoutes } from '../presentation/http/job.routes.ts'
import { mfaController } from '../presentation/http/mfa.controller.ts'
import { mfaRoutes } from '../presentation/http/mfa.routes.ts'
import { passageController } from '../presentation/http/passage.controller.ts'
import { passageRoutes } from '../presentation/http/passage.routes.ts'
import { buildOpenApiDocument } from '../presentation/http/openapi/document.ts'
import { docsRoutes } from '../presentation/http/openapi/docs.routes.ts'
import { requestId } from '../presentation/http/request.id.middleware.ts'
import { APP_VERSION } from './version.ts'
import { userController } from '../presentation/http/user.controller.ts'
import { userRoutes } from '../presentation/http/user.routes.ts'

/** Monta o app Express sem subir o servidor (os testes com supertest usam esta função). */
export function createApp(container: Container) {
    const app = express()
    app.disable('x-powered-by')
    // confia no X-Forwarded-For vindo de endereços privados (Kong na rede do Docker), para req.ip ser o IP do cliente
    app.set('trust proxy', 'loopback, uniquelocal')
    app.use(requestId)
    app.use(accessLog(container.logger.child('http')))
    // antes do express.json: corpo malformado (400) também é auditado
    if (container.audit) app.use(audit(container.audit.service, { ignorePaths: container.audit.ignorePaths }))
    app.use(express.json({ limit: '100kb' }))
    app.use(healthRoutes(container.health))
    if (container.apiDocs) app.use(docsRoutes(buildOpenApiDocument({ title: container.apiDocs.title, version: APP_VERSION })))
    const guards = authGuards(container.authService)
    app.use(authRoutes(authController(container.authService), guards))
    app.use(mfaRoutes(mfaController(container.mfaService), guards))
    app.use(userRoutes(userController(container.userService), guards))
    app.use(jobRoutes(jobController(container.jobService), guards))
    app.use(deviceRoutes(deviceController(container.deviceService), guards))
    app.use(passageRoutes(passageController(container.passageService), guards))
    app.use(errorHandler(container.logger.child('http'), { isUnavailable: container.isDependencyUnavailable }))
    return app
}
