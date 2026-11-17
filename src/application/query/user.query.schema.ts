import { USER_ROLES } from '../../domain/model/user.ts'
import type { QuerySchema } from './list.query.ts'

/** Filtros, ordenações e campos aceitos em GET /users e GET /clients. O hash da senha nunca aparece aqui. */
export const USER_QUERY_SCHEMA: QuerySchema = {
    fields: {
        id: { type: 'id' },
        name: { type: 'string', sort: true },
        email: { type: 'string', sort: true },
        role: { type: 'enum', values: USER_ROLES, sort: true },
        createdAt: { type: 'date', sort: true },
        updatedAt: { type: 'date', sort: true },
    },
    defaultSort: { name: 1 },
    dateField: 'createdAt',
    defaultLimit: 20,
    maxLimit: 100,
}
