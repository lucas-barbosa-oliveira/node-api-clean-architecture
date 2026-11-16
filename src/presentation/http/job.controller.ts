import type { Request, Response } from 'express'
import type { JobService } from '../../application/service/job.service.ts'

export function jobController(service: JobService) {
    return {
    /** 202 Accepted + Location: o trabalho segue em segundo plano; o cliente consulta GET /jobs/:id. */
        submitReport: async (req: Request, res: Response) => {
            const job = await service.submit('report.generate', req.body)
            res.status(202).location(`/jobs/${job.id}`).json(job)
        },
        getById: async (req: Request, res: Response) => {
            res.json(await service.getById(String(req.params.id)))
        },
    }
}
