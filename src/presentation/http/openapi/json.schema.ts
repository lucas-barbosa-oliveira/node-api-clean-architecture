import { z } from 'zod'

export type JsonSchema = Record<string, unknown>

/**
 * Converte um schema zod (o mesmo usado na validação) para JSON Schema, do jeito que a requisição deve chegar (io: input).
 * Remove o "pattern" gigante que o zod gera junto com formatos conhecidos (uuid, date-time): o "format" já diz o mesmo.
 */
export function fromZod(schema: z.ZodType): JsonSchema {
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema
    delete json.$schema
    return simplify(json) as JsonSchema
}

function simplify(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(simplify)
    if (value === null || typeof value !== 'object') return value
    const entries = Object.entries(value as JsonSchema)
    const hasFormat = entries.some(([key]) => key === 'format')
    return Object.fromEntries(entries
        .filter(([key]) => !(hasFormat && key === 'pattern'))
        // 2^53 - 1: limite do Number.MAX_SAFE_INTEGER que o zod coloca em z.int(); só polui a documentação
        .filter(([key, field]) => !(key === 'maximum' && field === Number.MAX_SAFE_INTEGER))
        .map(([key, field]) => [key, simplify(field)]))
}

/** Atalhos para os schemas de resposta, escritos à mão (os testes de contrato conferem com as respostas reais). */
export const S = {
    string: (extra: JsonSchema = {}): JsonSchema => ({ type: 'string', ...extra }),
    uuid: (description?: string): JsonSchema => ({ type: 'string', format: 'uuid', ...(description && { description }) }),
    dateTime: (description?: string): JsonSchema => ({
        type: 'string',
        format: 'date-time',
        ...(description && { description }),
    }),
    int: (extra: JsonSchema = {}): JsonSchema => ({ type: 'integer', ...extra }),
    enum: (values: readonly string[], description?: string): JsonSchema => ({
        type: 'string',
        enum: [...values],
        ...(description && { description }),
    }),
    ref: (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` }),
    array: (items: JsonSchema): JsonSchema => ({ type: 'array', items }),
    /** Objeto fechado: campos não documentados fazem o teste de contrato falhar. */
    object: (
        properties: Record<string, JsonSchema>,
        required: string[] = Object.keys(properties),
        description?: string,
    ): JsonSchema => ({
        type: 'object',
        ...(description && { description }),
        properties,
        required,
        additionalProperties: false,
    }),
}
