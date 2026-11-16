import type { Request, Response } from 'express'
import type { UserService } from '../../application/service/user.service.ts'
import { getActor } from './auth.middleware.ts'

export function userController(service: UserService) {
    return {
        create: async (req: Request, res: Response) => {
            res.status(201).json(await service.create(req.body))
        },
        me: async (_req: Request, res: Response) => {
            const actor = getActor(res)
            res.json(await service.getById(actor, actor.userId))
        },
        getById: async (req: Request, res: Response) => {
            res.json(await service.getById(getActor(res), String(req.params.id)))
        },
        listClients: async (_req: Request, res: Response) => {
            res.json(await service.listClients())
        },
    }
}
