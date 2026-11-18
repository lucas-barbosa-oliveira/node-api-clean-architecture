import { z } from 'zod'
import { ValidationError } from '../error/index.ts'

/** Código de 6 dígitos do aplicativo ou código de recuperação (XXXX-XXXX-XXXX-XXXX). Espaços são ignorados. */
const code = z.string().trim().min(6).max(32).describe('Código de 6 dígitos do aplicativo autenticador ou código de recuperação.')

export const mfaCodeSchema = z.object({ code })

/** Só o código do aplicativo (ex.: confirmar a configuração ou gerar novos códigos de recuperação). */
export const totpCodeSchema = z.object({
    code: z.string().trim().regex(/^\d{3} ?\d{3}$/, 'Informe os 6 dígitos do aplicativo autenticador')
        .describe('Código de 6 dígitos do aplicativo autenticador.'),
})

export const mfaVerifySchema = z.object({
    mfa_token: z.string().min(1).max(512).describe('Recebido em POST /auth/login quando o usuário tem MFA.'),
    code,
})

export function parseWith<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
    const parsed = schema.safeParse(input)
    if (!parsed.success) throw new ValidationError('Dados inválidos', parsed.error.issues)
    return parsed.data
}
