import type { Request, Response } from 'express'
import { DEVICE_QUERY_SCHEMA } from '../../application/query/device.query.schema.ts'
import type { DeviceService } from '../../application/service/device.service.ts'
import { getActor } from './auth.middleware.ts'
import { parseListQuery, sendPage } from './query/list.query.parser.ts'

export function deviceController(service: DeviceService) {
    return {
        /** O cliente (ou um admin) gera o código que será digitado na ESP32. */
        createPairingCode: async (req: Request, res: Response) => {
            const { code, expiresAt, expiresIn } = await service.createPairingCode(getActor(res), String(req.params.clientId))
            res.status(201).set('Cache-Control', 'no-store').json({ code, expires_at: expiresAt, expires_in: expiresIn })
        },
        /** A ESP32 troca o código pelo id do cliente e pelo token do dispositivo (rota pública). */
        claim: async (req: Request, res: Response) => {
            const { device, clientId, accessToken, expiresIn } = await service.claim(req.body)
            res.status(201).set('Cache-Control', 'no-store').json({
                device_id: device.id,
                client_id: clientId,
                access_token: accessToken,
                token_type: 'Bearer',
                expires_in: expiresIn,
            })
        },
        list: async (req: Request, res: Response) => {
            const query = parseListQuery(req, DEVICE_QUERY_SCHEMA)
            sendPage(res, await service.list(getActor(res), query), query)
        },
        revoke: async (req: Request, res: Response) => {
            await service.revoke(getActor(res), String(req.params.id))
            res.status(204).end()
        },
    }
}
