import { z } from 'zod'
import { ValidationError } from '../error/index.ts'
import { normalizeEmail } from '../utils/normalize.ts'

const createUserSchema = z.object({
    name: z.string().trim().min(2, 'Nome muito curto'),
    email: z.string().trim().pipe(z.email()).transform(normalizeEmail),
})

export type CreateUserInput = z.infer<typeof createUserSchema>

export function validateCreateUser(input: unknown): CreateUserInput {
    const result = createUserSchema.safeParse(input)
    if (!result.success) throw new ValidationError('Dados inválidos', result.error.issues)
    return result.data
}
