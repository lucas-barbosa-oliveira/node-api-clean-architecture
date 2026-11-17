import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import type { JobHandler } from '../../application/port/job.handler.ts'
import type { IJobQueue } from '../../application/port/job.queue.ts'
import type { IJobRepository } from '../../application/port/job.repository.ts'
import { runJob } from './run.job.ts'

/**
 * Fila em memória, no mesmo processo. Boa para desenvolvimento e instância única.
 * Não é durável nem compartilhada: para várias instâncias use BullMqJobQueue.
 */
export class InProcessJobQueue implements IJobQueue {
    #repo: IJobRepository
    #handlers: Record<string, JobHandler>
    #concurrency: number
    #pending: string[] = []
    #running = new Set<Promise<void>>()
    #closed = false
    #log: ILogger

    constructor(repo: IJobRepository, handlers: Record<string, JobHandler>, concurrency = 2, logger: ILogger = silentLogger) {
        this.#log = logger
        this.#repo = repo
        this.#handlers = handlers
        this.#concurrency = concurrency
    }

    public async enqueue(jobId: string): Promise<void> {
        this.#pending.push(jobId)
        this.#pump()
    }

    #pump(): void {
        while (!this.#closed && this.#running.size < this.#concurrency && this.#pending.length > 0) {
            const id = this.#pending.shift() as string
            const task: Promise<void> = this.#run(id).finally(() => {
                this.#running.delete(task)
                this.#pump()
            })
            this.#running.add(task)
        }
    }

    async #run(id: string): Promise<void> {
        try {
            await runJob(this.#repo, this.#handlers, id)
        } catch (err) {
            // nunca deixar a Promise rejeitar solta (derrubaria o processo)
            this.#log.error(`Job ${id}: falha no executor`, { err })
        }
    }

    /** Espera esvaziar a fila (útil em testes). */
    public async drain(): Promise<void> {
        while (this.#running.size > 0) await Promise.allSettled([...this.#running])
    }

    /** Para de iniciar novos jobs e espera os em andamento (shutdown). */
    public async close(): Promise<void> {
        this.#closed = true
        await Promise.allSettled([...this.#running])
    }
}
