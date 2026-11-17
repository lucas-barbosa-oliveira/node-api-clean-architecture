import type { Request, Response } from 'express'
import qs from 'query-strings-parser'
import {
    buildListQuery,
    type ListQuery,
    type Page,
    type QuerySchema,
    type RawListQuery,
} from '../../../application/query/list.query.ts'
import { ValidationError } from '../../../domain/error/index.ts'

/**
 * Metacaracteres de regex. A biblioteca monta regex a partir de valores com "*" sem escapá-los,
 * então padrões como (a+)+ chegariam ao banco (ReDoS). Só o "*" é aceito como curinga.
 */
const UNSAFE_VALUE = /[()[\]{}+?|\\^$]/
const MAX_QUERY_LENGTH = 2048

/**
 * Lê a query string com o query-strings-parser e valida o resultado contra o schema do recurso.
 *
 *   ?status=pending,running        status = pending OU running
 *   ?name=*ana*                    contém "ana" (sem diferenciar maiúsculas e acentos)
 *   ?createdAt=gte:2026-10-01      operadores gt, gte, lt, lte, ne
 *   ?start_at=2026-10-01&end_at=2026-11-01   intervalo no campo de data do recurso (end_at exclusivo)
 *   ?period=7d                     últimos 7 dias (d, w, m, y)
 *   ?sort=-createdAt,name          ordenação (- = decrescente)
 *   ?fields=id,status              campos da resposta
 *   ?page=2&limit=10               paginação (total no header X-Total-Count)
 *
 * O middleware da biblioteca não é usado: ele sobrescreve req.query, que é somente leitura no Express 5.
 */
export function parseListQuery(req: Request, schema: QuerySchema, options: { exclude?: string[] } = {}): ListQuery {
    return parseQueryString(req.originalUrl, schema, options)
}

/** O mesmo, a partir de uma URL ou query string (ex.: "?role=client&limit=10" recebida por RPC). */
export function parseQueryString(input: string, schema: QuerySchema, options: { exclude?: string[] } = {}): ListQuery {
    if (input.length > MAX_QUERY_LENGTH) throw new ValidationError('Query string muito longa')

    const mark = input.indexOf('?')
    const [path, rawSearch] = mark >= 0
        ? [input.slice(0, mark), input.slice(mark + 1)]
        : input.startsWith('/') ? [input, ''] : ['', input]
    const search = new URLSearchParams(rawSearch)
    // parâmetros próprios da rota (ex.: window do resumo) não são filtros
    for (const key of options.exclude ?? []) search.delete(key)
    const url = `${path || '/'}?${search.toString()}`

    const unsafe = [...search.entries()].filter(([, value]) => UNSAFE_VALUE.test(value)).map(([key]) => key)
    if (unsafe.length > 0) {
        throw new ValidationError(
            'Parâmetros de consulta inválidos',
            unsafe.map(key => ({ path: [key], message: 'Caracteres especiais não são permitidos; use * como curinga' })),
        )
    }

    const raw = qs.parser(
        url,
        { pagination: { limit: schema.defaultLimit, page: 1 } },
        { use_page: true, date_fields: { start_at: schema.dateField, end_at: schema.dateField } },
    ) as RawListQuery
    return buildListQuery(raw, schema)
}

/** Responde a página como array (compatível com clientes antigos) e o total em X-Total-Count. */
export function sendPage<T>(res: Response, page: Page<T>, query: ListQuery): void {
    res.set('X-Total-Count', String(page.total))
    res.json(selectFields(page.items, query))
}

/** Aplica ?fields= (sem fields, devolve os itens como estão). */
export function selectFields<T>(items: T[], query: ListQuery): unknown[] {
    return query.fields.length > 0 ? items.map(item => pick(item, query.fields)) : items
}

/** Aplica ?fields= sobre o JSON público do item (o id sempre vem). */
function pick(item: unknown, fields: string[]): Record<string, unknown> {
    const json = JSON.parse(JSON.stringify(item)) as Record<string, unknown>
    return Object.fromEntries(['id', ...fields].filter(field => field in json).map(field => [field, json[field]]))
}
