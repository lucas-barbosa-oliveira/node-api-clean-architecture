import { z } from 'zod'
import { ValidationError } from '../error/index.ts'
import { normalizeEmail } from '../utils/normalize.ts'

const email = z.string().trim().pipe(z.email()).transform(normalizeEmail)
const password = z.string().min(8, 'A senha deve ter ao menos 8 caracteres').max(128, 'Senha muito longa')

// o administrador não é cadastrado pela API: só gestores e clientes
const createUserSchema = z.object({
    name: z.string().trim().min(2, 'Nome muito curto'),
    email,
    password,
    role: z.enum(['manager', 'client']),
})

const loginSchema = z.object({
    email,
    password: z.string().min(1),
})

export type CreateUserInput = z.infer<typeof createUserSchema>
export type LoginInput = z.infer<typeof loginSchema>

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input)
    if (!result.success) throw new ValidationError('Dados inválidos', result.error.issues)
    return result.data
}

export const validateCreateUser = (input: unknown): CreateUserInput => parse(createUserSchema, input)
export const validateLogin = (input: unknown): LoginInput => parse(loginSchema, input)
