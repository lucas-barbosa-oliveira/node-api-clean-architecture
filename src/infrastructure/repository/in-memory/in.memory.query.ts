import type { Filter, ListQuery, Page, SortOrder } from '../../../application/query/list.query.ts'

/**
 * Avalia em memória o mesmo subconjunto de operadores que o Mongo recebe
 * ($and, $or, igualdade, $gt, $gte, $lt, $lte, $ne, $regex), para os dois drivers se comportarem igual.
 * O campo "id" do domínio corresponde a "_id" no documento.
 */
type Doc = Record<string, unknown>

const docField = (field: string) => (field === 'id' ? '_id' : field)
const comparable = (value: unknown) => (value instanceof Date ? value.getTime() : value)

export function matches(doc: Doc, filter: Filter): boolean {
    return Object.entries(filter).every(([key, condition]) => {
        if (key === '$and') return (condition as Filter[]).every(part => matches(doc, part))
        if (key === '$or') return (condition as Filter[]).some(part => matches(doc, part))
        return matchesCondition(doc[docField(key)], condition)
    })
}

function matchesCondition(value: unknown, condition: unknown): boolean {
    const isOperatorObject = condition !== null && typeof condition === 'object' && !(condition instanceof Date)
    if (!isOperatorObject) return comparable(value ?? null) === comparable(condition)

    const ops = condition as Record<string, unknown>
    if ('$regex' in ops) {
        return typeof value === 'string' && new RegExp(String(ops.$regex), String(ops.$options ?? '')).test(value)
    }
    const actual = comparable(value) as number | string | undefined
    return Object.entries(ops).every(([op, operand]) => {
        const expected = comparable(operand) as number | string
        if (op === '$ne') return comparable(value ?? null) !== expected
        // como no Mongo: campo ausente não satisfaz comparações de ordem
        if (actual === undefined || actual === null) return false
        if (op === '$gt') return actual > expected
        if (op === '$gte') return actual >= expected
        if (op === '$lt') return actual < expected
        if (op === '$lte') return actual <= expected
        return false
    })
}

function compare(a: Doc, b: Doc, sort: SortOrder): number {
    for (const [field, direction] of Object.entries(sort)) {
        const x = comparable(a[docField(field)]) as number | string | undefined
        const y = comparable(b[docField(field)]) as number | string | undefined
        if (x === y) continue
        if (x === undefined) return -direction // ausente vem primeiro na ordem crescente, como no Mongo
        if (y === undefined) return direction
        return (x < y ? -1 : 1) * direction
    }
    return 0
}

/** Filtra, ordena e pagina documentos já clonados. */
export function queryDocs<D extends object>(docs: D[], query: ListQuery): Page<D> {
    const filtered = docs.filter(doc => matches(doc as Doc, query.filter))
    const items = filtered
        .toSorted((a, b) => compare(a as Doc, b as Doc, query.sort))
        .slice(query.skip, query.skip + query.limit)
    return { items, total: filtered.length }
}
