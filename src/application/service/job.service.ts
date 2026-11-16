import { NotFoundError } from '../../domain/error/index.ts'
import { Job } from '../../domain/model/job.ts'
import { validateJobPayload } from '../../domain/validator/job.validator.ts'
import type { IJobQueue } from '../port/job.queue.ts'
import type { IJobRepository } from '../port/job.repository.ts'

export class JobService {
    #repo: IJobRepository
    #queue: IJobQueue

    constructor(repo: IJobRepository, queue: IJobQueue) {
        this.#repo = repo
        this.#queue = queue
    }

    /** Registra o job como "pending", enfileira e retorna imediatamente. */
    public async submit(type: string, payload: unknown): Promise<Job> {
        const job = Job.create(type, validateJobPayload(type, payload))
        await this.#repo.save(job)
        await this.#queue.enqueue(job.id)
        return job
    }

    public async getById(id: string): Promise<Job> {
        const job = await this.#repo.findById(id)
        if (!job) throw new NotFoundError('Job não encontrado')
        return job
    }

    /**
   * Recuperação após reinício (apenas para a fila em processo, instância única):
   * o que estava "running" foi interrompido; o que estava "pending" volta para a fila.
   */
    public async recoverStale(): Promise<void> {
        for (const job of await this.#repo.findByStatus('running')) {
            job.fail('Interrompido por reinício da aplicação')
            await this.#repo.save(job)
        }
        for (const job of await this.#repo.findByStatus('pending')) {
            await this.#queue.enqueue(job.id)
        }
    }

    public async purgeOlderThan(days: number): Promise<number> {
        return this.#repo.deleteFinishedBefore(new Date(Date.now() - days * 86_400_000))
    }
}
