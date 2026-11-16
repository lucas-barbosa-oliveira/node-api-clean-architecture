import type { Request, Response } from 'express'
import type { JobService } from '../../application/service/job.service.ts'
import { getActor } from './auth.middleware.ts'

export function jobController(service: JobService) {
    return {
        /**
         * Corpo: { clientId, month }. O gestor do job vem do token.
         * 202 Accepted + Location: o trabalho segue em segundo plano; o cliente consulta GET /jobs/:id.
         */
        submitReport: async (req: Request, res: Response) => {
            const { clientId, ...payload } = (req.body ?? {}) as Record<string, unknown>
            const job = await service.submit(getActor(res), { type: 'report.generate', clientId, payload })
            res.status(202).location(`/jobs/${job.id}`).json(job)
        },
        list: async (_req: Request, res: Response) => {
            res.json(await service.list(getActor(res)))
        },
        getById: async (req: Request, res: Response) => {
            res.json(await service.getById(getActor(res), String(req.params.id)))
        },
    }
}
