import type { Request, Response } from 'express'
import { PASSAGE_QUERY_SCHEMA } from '../../application/query/passage.query.schema.ts'
import { parseTimeWindow } from '../../application/query/time.window.ts'
import type { PassageService } from '../../application/service/passage.service.ts'
import { getActor } from './auth.middleware.ts'
import { parseListQuery, sendPage } from './query/list.query.parser.ts'

export function passageController(service: PassageService) {
    return {
        /** Lote de passagens enviado pela ESP32 (token de dispositivo). 202: gravado na série temporal. */
        ingest: async (req: Request, res: Response) => {
            res.status(202).json(await service.ingest(getActor(res), String(req.params.deviceId), req.body))
        },
        list: async (req: Request, res: Response) => {
            const query = parseListQuery(req, PASSAGE_QUERY_SCHEMA)
            sendPage(res, await service.list(getActor(res), query), query)
        },
        /** Contagem de entradas/saídas por janela: ?window=1h&period=1d&deviceId=... */
        summary: async (req: Request, res: Response) => {
            const window = parseTimeWindow(new URLSearchParams(req.originalUrl.split('?')[1] ?? '').get('window') ?? undefined)
            const query = parseListQuery(req, PASSAGE_QUERY_SCHEMA, { exclude: ['window'] })
            const windows = await service.summarize(getActor(res), query, window)
            res.json({ window: window.every, windows })
        },
    }
}
