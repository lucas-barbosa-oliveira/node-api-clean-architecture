import type { HealthCheck, HealthStatus } from '../port/health.check.ts'

export type ReadinessReport = {
    status: 'ready' | 'not_ready';
    checks: Record<string, HealthStatus & { critical: boolean; latency_ms: number }>;
}

const CHECK_TIMEOUT_MS = 2000

/**
 * Liveness: o processo está de pé (se falhar, o orquestrador reinicia o container).
 * Readiness: a instância consegue atender (se falhar, o balanceador para de mandar tráfego, sem reiniciar).
 */
export class HealthService {
    #checks: HealthCheck[]
    #startedAt = Date.now()
    #shuttingDown = false

    constructor(checks: HealthCheck[]) {
        this.#checks = checks
    }

    public liveness(): { status: 'ok'; uptime_seconds: number } {
        return { status: 'ok', uptime_seconds: Math.round((Date.now() - this.#startedAt) / 1000) }
    }

    /** No encerramento a instância deixa de estar pronta antes de fechar as conexões (o balanceador para de enviar tráfego). */
    public markShuttingDown(): void {
        this.#shuttingDown = true
    }

    public async readiness(): Promise<ReadinessReport> {
        const entries = await Promise.all(this.#checks.map(async check => {
            const start = Date.now()
            const result = await withTimeout(check.check(), CHECK_TIMEOUT_MS).catch((err: unknown): HealthStatus => ({
                status: 'down',
                details: { error: err instanceof Error ? err.message : String(err) },
            }))
            return [check.name, { ...result, critical: check.critical, latency_ms: Date.now() - start }] as const
        }))
        const checks = Object.fromEntries(entries)
        if (this.#shuttingDown) {
            checks.shutdown = { status: 'down', critical: true, latency_ms: 0, details: { reason: 'encerrando' } }
        }
        const ready = Object.values(checks).every(check => !check.critical || check.status === 'up')
        return { status: ready ? 'ready' : 'not_ready', checks }
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`sem resposta em ${ms} ms`)), ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
