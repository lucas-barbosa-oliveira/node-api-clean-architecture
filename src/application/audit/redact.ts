export const REDACTED = '[REDACTED]'

/** Campos que nunca vão para a auditoria (comparação sem diferenciar maiúsculas). */
const ALWAYS_SECRET = new Set([
    'password',
    'passwordhash',
    'token',
    'access_token',
    'accesstoken',
    'refresh_token',
    'refreshtoken',
    'secret',
    // MFA: credencial da segunda etapa do login, códigos de recuperação e a URL do QR code (contém o segredo)
    'mfa_token',
    'recovery_codes',
    'otpauth_url',
    'authorization',
    'cookie',
])

/**
 * Copia o valor trocando segredos por [REDACTED].
 * extraKeys: campos sensíveis só em alguns contextos (ex.: "code" do pareamento, que também é o nome do campo de erro).
 */
export function redact(value: unknown, extraKeys: readonly string[] = [], depth = 0): unknown {
    if (depth > 20 || value === null || typeof value !== 'object') return value
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return value.map(item => redact(item, extraKeys, depth + 1))
    const extra = new Set(extraKeys.map(key => key.toLowerCase()))
    return Object.fromEntries(Object.entries(value).map(([key, field]) => {
        const lower = key.toLowerCase()
        if (ALWAYS_SECRET.has(lower) || extra.has(lower)) return [key, REDACTED]
        return [key, redact(field, extraKeys, depth + 1)]
    }))
}

/** Corpo grande (ex.: listagens) vira um resumo, para a mensagem não pesar no barramento. */
export function limitSize(value: unknown, maxBytes: number): unknown {
    if (value === undefined) return undefined
    const size = Buffer.byteLength(JSON.stringify(value) ?? '')
    return size <= maxBytes ? value : { _truncated: true, _size_bytes: size }
}
