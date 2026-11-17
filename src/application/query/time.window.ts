import { ValidationError } from '../../domain/error/index.ts'

/** Janela de agregação, ex.: "15m", "1h", "1d". `every` vai para o Flux; `ms` para o cálculo em memória. */
export type TimeWindow = { every: string; ms: number }

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const MAX_WINDOW_MS = 31 * 86_400_000
/** Evita respostas gigantes (ex.: janela de 1m em um ano). */
export const MAX_WINDOWS = 1000

export function parseTimeWindow(value: unknown, fallback = '1h'): TimeWindow {
    const text = value === undefined ? fallback : String(value)
    const match = /^(\d{1,4})([mhd])$/.exec(text)
    const ms = match ? Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] : 0
    if (!match || ms < UNIT_MS.m || ms > MAX_WINDOW_MS) {
        throw new ValidationError('Parâmetros de consulta inválidos', [
            { path: ['window'], message: 'Use um número seguido de m, h ou d (ex.: 15m, 1h, 1d), de 1m a 31d' },
        ])
    }
    return { every: text, ms }
}
