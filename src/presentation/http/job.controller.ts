import type { Request, Response } from 'express'
import { JOB_QUERY_SCHEMA } from '../../application/query/job.query.schema.ts'
import type { JobService } from '../../application/service/job.service.ts'
import { getActor } from './auth.middleware.ts'
import { parseListQuery, sendPage } from './query/list.query.parser.ts'

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
        /** Filtros, ordenação, campos e paginação pela query string (ver JOB_QUERY_SCHEMA). */
        list: async (req: Request, res: Response) => {
            const query = parseListQuery(req, JOB_QUERY_SCHEMA)
            sendPage(res, await service.list(getActor(res), query), query)
        },
        getById: async (req: Request, res: Response) => {
            res.json(await service.getById(getActor(res), String(req.params.id)))
        },
    }
}
