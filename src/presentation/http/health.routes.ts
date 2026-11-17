import { Router, type RequestHandler } from 'express'
import type { HealthService } from '../../application/service/health.service.ts'

/**
 *   GET /health, /health/live   o processo está de pé (Docker HEALTHCHECK; se falhar, o container é reiniciado)
 *   GET /health/ready           consegue atender: 200 com tudo crítico no ar, 503 caso contrário (balanceador/Kong
 *                               param de mandar tráfego, sem reiniciar). Lista o estado de cada dependência.
 */
export function healthRoutes(health: HealthService): Router {
    const router = Router()
    const live: RequestHandler = (_req, res) => {
        res.set('Cache-Control', 'no-store').json(health.liveness())
    }
    router.get('/health', live)
    router.get('/health/live', live)
    router.get('/health/ready', async (_req, res) => {
        const report = await health.readiness()
        res.status(report.status === 'ready' ? 200 : 503).set('Cache-Control', 'no-store').json(report)
    })
    return router
}
