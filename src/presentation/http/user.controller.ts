import type { Request, Response } from 'express'
import type { UserService } from '../../application/service/user.service.ts'

export function userController(service: UserService) {
    return {
        create: async (req: Request, res: Response) => {
            res.status(201).json(await service.create(req.body))
        },
        getById: async (req: Request, res: Response) => {
            res.json(await service.getById(String(req.params.id)))
        },
    }
}
