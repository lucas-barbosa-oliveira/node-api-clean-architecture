import { JOB_STATUSES } from '../../domain/model/job.ts'
import type { QuerySchema } from './list.query.ts'

/** Filtros, ordenações e campos aceitos em GET /jobs. */
export const JOB_QUERY_SCHEMA: QuerySchema = {
    fields: {
        id: { type: 'id' },
        type: { type: 'string', sort: true },
        status: { type: 'enum', values: JOB_STATUSES, sort: true },
        managerId: { type: 'id' },
        clientId: { type: 'id' },
        payload: { type: 'string', filter: false },
        result: { type: 'string', filter: false },
        error: { type: 'string', filter: false },
        createdAt: { type: 'date', sort: true },
        updatedAt: { type: 'date', sort: true },
        startedAt: { type: 'date', sort: true },
        finishedAt: { type: 'date', sort: true },
    },
    defaultSort: { createdAt: -1 },
    dateField: 'createdAt',
    defaultLimit: 20,
    maxLimit: 100,
}
