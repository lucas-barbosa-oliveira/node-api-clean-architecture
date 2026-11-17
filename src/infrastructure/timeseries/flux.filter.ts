import { fluxDateTime, fluxString } from '@influxdata/influxdb-client'
import type { Filter } from '../../application/query/list.query.ts'
import { ValidationError } from '../../domain/error/index.ts'

/** Campo do domínio -> coluna no Flux. Só tags e tempo: são indexados no InfluxDB. */
const COLUMNS: Record<string, string> = {
    deviceId: 'r.deviceId',
    clientId: 'r.clientId',
    direction: 'r.direction',
    occurredAt: 'r._time',
}

const OPERATORS: Record<string, string> = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=', $ne: '!=' }

/** Valor literal escapado pela biblioteca oficial (os valores já chegam validados por tipo, isto é uma segunda barreira). */
function literal(value: unknown): string {
    if (value instanceof Date) return String(fluxDateTime(value.toISOString()))
    if (typeof value === 'string') return String(fluxString(value))
    throw new ValidationError(`Valor não suportado em consulta de série temporal: ${JSON.stringify(value)}`)
}

/**
 * Converte o filtro da ListQuery (já validado pelo PASSAGE_QUERY_SCHEMA) em um predicado Flux
 * para usar em filter(fn: (r) => ...). Filtro vazio vira "true".
 */
export function toFluxPredicate(filter: Filter): string {
    const parts: string[] = []
    for (const [key, value] of Object.entries(filter)) {
        if (key === '$and' || key === '$or') {
            const inner = (value as Filter[]).map(toFluxPredicate)
            if (inner.length > 0) parts.push(`(${inner.join(key === '$and' ? ' and ' : ' or ')})`)
            continue
        }
        const column = COLUMNS[key]
        if (!column) throw new ValidationError(`Filtro não suportado na série temporal: "${key}"`)

        if (value === null || typeof value !== 'object' || value instanceof Date) {
            parts.push(`${column} == ${literal(value)}`)
            continue
        }
        for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
            const operator = OPERATORS[op]
            if (!operator) throw new ValidationError(`Operador não suportado na série temporal: ${op}`)
            parts.push(`${column} ${operator} ${literal(operand)}`)
        }
    }
    return parts.length > 0 ? parts.join(' and ') : 'true'
}
