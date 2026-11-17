import type { FieldRule, QuerySchema } from '../../../application/query/list.query.ts'
import type { JsonSchema } from './json.schema.ts'

type Parameter = { name: string; in: 'query'; description: string; schema: JsonSchema; example?: unknown }

const FILTER_HELP: Record<FieldRule['type'], string> = {
    id: 'Valor exato. Vários separados por vírgula = qualquer um deles.',
    string: 'Valor exato, ou com * como curinga (ex.: *ana*). Sem diferenciar maiúsculas e acentos.',
    enum: 'Valor exato. Vários separados por vírgula = qualquer um deles.',
    number: 'Valor exato ou com operador: gt:, gte:, lt:, lte:, ne: (ex.: gte:10).',
    date: 'Data (AAAA-MM-DD ou AAAA-MM-DDTHH:mm:ss) ou com operador: gt:, gte:, lt:, lte: (ex.: gte:2026-11-01).',
}

/**
 * Parâmetros de listagem gerados a partir da whitelist do recurso (o mesmo QuerySchema que valida a requisição):
 * paginação, ordenação, campos, intervalo de datas e um parâmetro por campo filtrável.
 */
export function listParameters(schema: QuerySchema): Parameter[] {
    const fields = Object.entries(schema.fields)
    const sortable = fields.filter(([, rule]) => rule.sort).map(([name]) => name)
    const [defaultSortField, defaultDirection] = Object.entries(schema.defaultSort)[0] ?? []
    const defaultSort = defaultSortField ? `${defaultDirection === -1 ? '-' : ''}${defaultSortField}` : ''

    const parameters: Parameter[] = [
        {
            name: 'page',
            in: 'query',
            description: 'Página (começa em 1). O total de itens vem no header X-Total-Count.',
            schema: { type: 'integer', minimum: 1, default: 1 },
        },
        {
            name: 'limit',
            in: 'query',
            description: `Itens por página (máximo ${schema.maxLimit}).`,
            schema: { type: 'integer', minimum: 1, maximum: schema.maxLimit, default: schema.defaultLimit },
        },
        {
            name: 'sort',
            in: 'query',
            description: 'Ordenação: campos separados por vírgula; "-" na frente = decrescente. '
                + `Permitidos: ${sortable.join(', ')}. `
                + `Padrão: ${defaultSort}.`,
            schema: { type: 'string' },
            ...(sortable[0] && { example: `-${sortable.includes(schema.dateField) ? schema.dateField : sortable[0]}` }),
        },
        {
            name: 'fields',
            in: 'query',
            description: 'Campos da resposta, separados por vírgula (o id sempre vem). '
                + `Disponíveis: ${fields.map(([name]) => name).join(', ')}.`,
            schema: { type: 'string' },
        },
        {
            name: 'start_at',
            in: 'query',
            description: `Início do intervalo em ${schema.dateField} (inclusivo). AAAA-MM-DD ou AAAA-MM-DDTHH:mm:ssZ.`,
            schema: { type: 'string' },
        },
        {
            name: 'end_at',
            in: 'query',
            description: `Fim do intervalo em ${schema.dateField} (exclusivo).`,
            schema: { type: 'string' },
        },
        {
            name: 'period',
            in: 'query',
            description: `Últimos N dias/semanas/meses/anos em ${schema.dateField}: 7d, 2w, 1m, 1y. `
                + 'Calculado em dias inteiros no fuso do servidor: para intervalos exatos, use start_at/end_at com horário.',
            schema: { type: 'string', pattern: '^\\d+[dwmy]$' },
        },
    ]

    for (const [name, rule] of fields) {
        if (rule.filter === false) continue
        const values = rule.type === 'enum' && rule.values ? ` Valores: ${rule.values.join(', ')}.` : ''
        parameters.push({
            name,
            in: 'query',
            description: `Filtro por ${name}. ${FILTER_HELP[rule.type]}${values}`,
            schema: { type: 'string' },
        })
    }
    return parameters
}
