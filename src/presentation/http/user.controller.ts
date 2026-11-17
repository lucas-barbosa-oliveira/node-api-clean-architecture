import type { Request, Response } from 'express'
import { USER_QUERY_SCHEMA } from '../../application/query/user.query.schema.ts'
import type { UserService } from '../../application/service/user.service.ts'
import { getActor } from './auth.middleware.ts'
import { parseListQuery, sendPage } from './query/list.query.parser.ts'

export function userController(service: UserService) {
    return {
        create: async (req: Request, res: Response) => {
            res.status(201).json(await service.create(req.body))
        },
        list: async (req: Request, res: Response) => {
            const query = parseListQuery(req, USER_QUERY_SCHEMA)
            sendPage(res, await service.list(query), query)
        },
        me: async (_req: Request, res: Response) => {
            const actor = getActor(res)
            res.json(await service.getById(actor, actor.userId))
        },
        getById: async (req: Request, res: Response) => {
            res.json(await service.getById(getActor(res), String(req.params.id)))
        },
        listClients: async (req: Request, res: Response) => {
            const query = parseListQuery(req, USER_QUERY_SCHEMA)
            sendPage(res, await service.listClients(query), query)
        },
    }
}
