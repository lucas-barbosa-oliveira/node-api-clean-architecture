import { PASSAGE_DIRECTIONS } from '../../domain/model/passage.ts'
import type { QuerySchema } from './list.query.ts'

/**
 * Filtros aceitos em GET /passages e GET /passages/summary.
 * Os campos filtráveis são as tags e o tempo da série no InfluxDB (consultas rápidas); o resto só pode ser selecionado.
 */
export const PASSAGE_QUERY_SCHEMA: QuerySchema = {
    fields: {
        deviceId: { type: 'id' },
        clientId: { type: 'id' },
        direction: { type: 'enum', values: PASSAGE_DIRECTIONS },
        occurredAt: { type: 'date', sort: true },
        eventId: { type: 'id', filter: false },
        sequence: { type: 'number', filter: false },
        receivedAt: { type: 'date', filter: false },
    },
    defaultSort: { occurredAt: -1 },
    dateField: 'occurredAt',
    defaultLimit: 50,
    maxLimit: 1000,
}
