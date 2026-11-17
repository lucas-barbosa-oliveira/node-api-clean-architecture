import { DEVICE_STATUSES } from '../../domain/model/device.ts'
import type { QuerySchema } from './list.query.ts'

/** Filtros, ordenações e campos aceitos em GET /devices. */
export const DEVICE_QUERY_SCHEMA: QuerySchema = {
    fields: {
        id: { type: 'id' },
        clientId: { type: 'id' },
        name: { type: 'string', sort: true },
        hardwareId: { type: 'string' },
        firmware: { type: 'string' },
        status: { type: 'enum', values: DEVICE_STATUSES, sort: true },
        createdAt: { type: 'date', sort: true },
        lastSeenAt: { type: 'date', sort: true },
        revokedAt: { type: 'date' },
    },
    defaultSort: { createdAt: -1 },
    dateField: 'createdAt',
    defaultLimit: 20,
    maxLimit: 100,
}
