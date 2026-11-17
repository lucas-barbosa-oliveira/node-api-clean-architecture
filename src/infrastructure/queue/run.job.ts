import type { JobHandler } from '../../application/port/job.handler.ts'
import type { IJobRepository } from '../../application/port/job.repository.ts'
import { appMetrics } from '../telemetry/metrics.ts'

/**
 * Executa um job: marca como running, chama o handler e grava o resultado.
 * Erros do handler viram status "failed" (não são relançados).
 * Erros de infraestrutura (ex.: banco fora do ar) sobem, para a fila poder tentar de novo.
 */
export async function runJob(
    repo: IJobRepository,
    handlers: Record<string, JobHandler>,
    jobId: string,
): Promise<void> {
    const job = await repo.findById(jobId)
    if (!job || job.status === 'succeeded' || job.status === 'failed') return // reentrega: não refazer

    job.start()
    await repo.save(job)
    const startedAt = performance.now()

    try {
        const handler = handlers[job.type]
        if (!handler) throw new Error(`Sem handler para o tipo ${job.type}`)
        job.succeed(await handler(job))
    } catch (err) {
        job.fail(err instanceof Error ? err.message : String(err))
    }
    await repo.save(job)
    appMetrics.jobsCompleted.add(1, { type: job.type, status: job.status })
    appMetrics.jobDuration.record((performance.now() - startedAt) / 1000, { type: job.type, status: job.status })
}
