import { EventBusUnavailableError } from '../../application/port/event.bus.ts'

/** Erros dos drivers que significam "dependência fora do ar" (não um bug): viram 503 com Retry-After. */
const UNAVAILABLE_NAMES = new Set([
    // MongoDB / Mongoose
    'MongoServerSelectionError',
    'MongooseServerSelectionError',
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoNotConnectedError',
    'MongoTopologyClosedError',
    'MongoPoolClearedError',
    // ioredis
    'MaxRetriesPerRequestError',
    // InfluxDB
    'RequestTimedOutError',
    EventBusUnavailableError.name,
    // Vault (Transit do MFA)
    'VaultUnavailableError',
])
const UNAVAILABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN'])
const UNAVAILABLE_MESSAGES = /Connection is closed|Stream isn't writeable|connect ECONNREFUSED/i

/** Percorre a cadeia de causas (err.cause), onde os drivers costumam guardar o erro de rede original. */
export function isDependencyUnavailable(err: unknown): boolean {
    for (let current = err, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
        const { name, message } = current
        const code = (current as { code?: unknown }).code
        const byCode = typeof code === 'string' && UNAVAILABLE_CODES.has(code)
        if (UNAVAILABLE_NAMES.has(name) || byCode || UNAVAILABLE_MESSAGES.test(message)) {
            return true
        }
        if (current instanceof AggregateError && current.errors.some(isDependencyUnavailable)) return true
    }
    return false
}
