import { ValidationError } from '../../domain/error/index.ts'

/**
 * Consulta de listagem independente de banco: filtros no formato de operadores
 * ($and, $or, $gt, $gte, $lt, $lte, $ne, $regex), ordenação, campos e paginação.
 * Os repositórios traduzem para o banco (Mongo) ou avaliam em memória.
 */
export type SortOrder = Record<string, 1 | -1>
export type Filter = { [field: string]: unknown }
export type ListQuery = {
    filter: Filter;
    sort: SortOrder;
    /** Campos pedidos em ?fields=. Vazio = todos. */
    fields: string[];
    limit: number;
    skip: number;
    page: number;
}
export type Page<T> = { items: T[]; total: number }

export type FieldType = 'id' | 'string' | 'enum' | 'number' | 'date'
export type FieldRule = {
    type: FieldType;
    /** Valores aceitos quando type = 'enum'. */
    values?: readonly string[];
    /** Pode ser usado em filtros (padrão: true). */
    filter?: boolean;
    /** Pode ser usado em ?sort= (padrão: false). */
    sort?: boolean;
}

/** O que cada recurso expõe para filtro, ordenação e seleção de campos. Campo fora daqui é recusado. */
export type QuerySchema = {
    fields: Record<string, FieldRule>;
    defaultSort: SortOrder;
    /** Campo usado por start_at, end_at e period. */
    dateField: string;
    defaultLimit: number;
    maxLimit: number;
}

/** Formato produzido pelo query-strings-parser. */
export type RawListQuery = {
    filters?: Filter;
    sort?: Record<string, number>;
    fields?: Record<string, number>;
    pagination?: { limit?: number; page?: number };
}

type ReportIssue = (path: string, message: string) => void

const COMPARISON_OPERATORS = new Set(['$gt', '$gte', '$lt', '$lte', '$ne'])
const MAX_REGEX_LENGTH = 300

/** Valida a consulta contra o schema do recurso. Problemas viram um único ValidationError (400) com todos os itens. */
export function buildListQuery(raw: RawListQuery, schema: QuerySchema): ListQuery {
    const issues: { path: string[]; message: string }[] = []
    const issue = (path: string, message: string) => issues.push({ path: [path], message })

    const filter = sanitizeFilter(raw.filters ?? {}, schema, issue)

    const sort: SortOrder = {}
    for (const [field, direction] of Object.entries(raw.sort ?? {})) {
        if (!schema.fields[field]?.sort) issue('sort', `Ordenação não permitida por "${field}"`)
        else sort[field] = direction === -1 ? -1 : 1
    }

    const fields = Object.keys(raw.fields ?? {})
    for (const field of fields) {
        if (!schema.fields[field]) issue('fields', `Campo desconhecido: "${field}"`)
    }

    if (issues.length > 0) throw new ValidationError('Parâmetros de consulta inválidos', issues)

    const limit = Math.min(Math.max(raw.pagination?.limit || schema.defaultLimit, 1), schema.maxLimit)
    const page = Math.max(raw.pagination?.page || 1, 1)
    return {
        filter,
        sort: Object.keys(sort).length > 0 ? sort : schema.defaultSort,
        fields,
        limit,
        page,
        skip: (page - 1) * limit,
    }
}

/** Combina filtros com $and, ignorando os vazios. Usado para somar a restrição de acesso ao filtro do usuário. */
export function and(...filters: Filter[]): Filter {
    const parts = filters.filter(part => Object.keys(part).length > 0)
    if (parts.length === 0) return {}
    return parts.length === 1 ? parts[0] : { $and: parts }
}

function sanitizeFilter(filter: Filter, schema: QuerySchema, issue: ReportIssue): Filter {
    const result: Filter = {}
    for (const [key, value] of Object.entries(filter)) {
        if (key === '$and' || key === '$or') {
            result[key] = (Array.isArray(value) ? value : []).map(part => sanitizeFilter(part as Filter, schema, issue))
            continue
        }
        const rule = schema.fields[key]
        if (!rule || rule.filter === false) {
            issue(key, `Filtro não permitido: "${key}"`)
            continue
        }
        result[key] = sanitizeCondition(key, value, rule, issue)
    }
    return result
}

function sanitizeCondition(key: string, value: unknown, rule: FieldRule, issue: ReportIssue): unknown {
    if (value === null || typeof value !== 'object' || value instanceof Date) return coerce(key, value, rule, issue)

    const condition = value as Record<string, unknown>
    if ('$regex' in condition) {
        // a biblioteca transforma "*texto*" em regex (case-insensitive e tolerante a acentos)
        if (rule.type !== 'string') {
            issue(key, `Busca com * só é permitida em campos de texto ("${key}" é ${rule.type})`)
            return undefined
        }
        const pattern = String(condition.$regex)
        if (pattern.length > MAX_REGEX_LENGTH) issue(key, 'Texto de busca muito longo')
        return { $regex: pattern, $options: 'i' }
    }

    const result: Record<string, unknown> = {}
    for (const [operator, operand] of Object.entries(condition)) {
        if (!COMPARISON_OPERATORS.has(operator)) {
            issue(key, `Operador não permitido: ${operator}`)
            continue
        }
        if (operator !== '$ne' && (rule.type === 'id' || rule.type === 'enum')) {
            issue(key, `Comparação ${operator.slice(1)}: não se aplica a "${key}"`)
            continue
        }
        result[operator] = coerce(key, operand, rule, issue)
    }
    return result
}

/** A biblioteca devolve tudo como string (ou número, se parecer número); aqui cada valor vira o tipo do campo. */
function coerce(key: string, value: unknown, rule: FieldRule, issue: ReportIssue): unknown {
    if (value === null) return null
    switch (rule.type) {
    case 'id':
    case 'string':
        return String(value)
    case 'enum': {
        const text = String(value)
        if (!rule.values?.includes(text)) issue(key, `Valor inválido para "${key}". Use: ${rule.values?.join(', ')}`)
        return text
    }
    case 'number': {
        const number = Number(value)
        if (!Number.isFinite(number)) issue(key, `"${key}" deve ser numérico`)
        return number
    }
    case 'date': {
        const date = value instanceof Date ? value : new Date(String(value))
        if (Number.isNaN(date.getTime())) issue(key, `"${key}" deve ser uma data (AAAA-MM-DD ou AAAA-MM-DDTHH:mm:ss)`)
        return date
    }
    }
}

/**
 * Intervalo [start, stop) implícito em um filtro para um campo de data, olhando o nível de cima e os $and
 * (onde start_at/end_at/period da query string aparecem). Condições dentro de $or não restringem o intervalo.
 */
export function timeBounds(filter: Filter, field: string): { start?: Date; stop?: Date } {
    let start: Date | undefined
    let stop: Date | undefined
    const later = (a: Date | undefined, b: Date) => (a && a > b ? a : b)
    const earlier = (a: Date | undefined, b: Date) => (a && a < b ? a : b)
    const plus1ms = (date: Date) => new Date(date.getTime() + 1)

    const visit = (part: Filter) => {
        for (const [key, value] of Object.entries(part)) {
            if (key === '$and') (value as Filter[]).forEach(visit)
            if (key !== field) continue
            if (value instanceof Date) {
                start = later(start, value)
                stop = earlier(stop, plus1ms(value))
                continue
            }
            for (const [op, operand] of Object.entries((value ?? {}) as Record<string, unknown>)) {
                if (!(operand instanceof Date)) continue
                if (op === '$gte') start = later(start, operand)
                if (op === '$gt') start = later(start, plus1ms(operand))
                if (op === '$lt') stop = earlier(stop, operand)
                if (op === '$lte') stop = earlier(stop, plus1ms(operand))
            }
        }
    }
    visit(filter)
    return { start, stop }
}
