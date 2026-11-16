import { z } from 'zod'
import { ValidationError } from '../error/index.ts'

/** Um schema por tipo de job. Para um novo tipo, registre aqui o formato do payload. */
const schemas: Record<string, z.ZodType> = {
    'report.generate': z.object({
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use o formato AAAA-MM'),
    }),
}

const clientIdSchema = z.string().trim().min(1, 'Informe o clientId')

export function validateClientId(clientId: unknown): string {
    const result = clientIdSchema.safeParse(clientId)
    if (!result.success) throw new ValidationError('Dados inválidos', result.error.issues)
    return result.data
}

export function validateJobPayload(type: string, payload: unknown): unknown {
    const schema = schemas[type]
    if (!schema) throw new ValidationError(`Tipo de job desconhecido: ${type}`)
    const result = schema.safeParse(payload)
    if (!result.success) throw new ValidationError('Dados inválidos', result.error.issues)
    return result.data
}
