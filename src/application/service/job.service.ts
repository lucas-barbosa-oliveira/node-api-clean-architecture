import { hasScope, type Actor } from '../../domain/auth/actor.ts'
import { SCOPES } from '../../domain/auth/scopes.ts'
import { NotFoundError, ValidationError } from '../../domain/error/index.ts'
import { Job } from '../../domain/model/job.ts'
import { validateClientId, validateJobPayload } from '../../domain/validator/job.validator.ts'
import type { IJobQueue } from '../port/job.queue.ts'
import type { IJobRepository } from '../port/job.repository.ts'
import type { IUserRepository } from '../port/user.repository.ts'

export type SubmitJobInput = { type: string; clientId: unknown; payload: unknown }

export class JobService {
    #repo: IJobRepository
    #queue: IJobQueue
    #users: IUserRepository

    constructor(repo: IJobRepository, queue: IJobQueue, users: IUserRepository) {
        this.#repo = repo
        this.#queue = queue
        this.#users = users
    }

    /**
     * O gestor (actor) cadastra um job para um cliente: registra como "pending", enfileira e retorna imediatamente.
     * O gestor do job vem sempre do token, nunca do corpo da requisição.
     */
    public async submit(actor: Actor, input: SubmitJobInput): Promise<Job> {
        const payload = validateJobPayload(input.type, input.payload)
        const clientId = validateClientId(input.clientId)

        const client = await this.#users.findById(clientId)
        if (client?.role !== 'client') {
            throw new ValidationError('Dados inválidos', [{ path: ['clientId'], message: 'Cliente não encontrado' }])
        }

        const job = Job.create({ type: input.type, payload, managerId: actor.userId, clientId })
        await this.#repo.save(job)
        await this.#queue.enqueue(job.id)
        return job
    }

    /**
     * Gestor vê os jobs que criou; cliente vê os associados a ele; jobs:read:any vê todos.
     * Job de outra pessoa responde 404 (e não 403), para não revelar quais ids existem.
     */
    public async getById(actor: Actor, id: string): Promise<Job> {
        const job = await this.#repo.findById(id)
        if (!job || !this.#canSee(actor, job)) throw new NotFoundError('Job não encontrado')
        return job
    }

    /** O filtro vai para a consulta: nunca busca tudo para filtrar depois. */
    public list(actor: Actor): Promise<Job[]> {
        return hasScope(actor, SCOPES.jobsReadAny) ? this.#repo.findAll() : this.#repo.findByParticipant(actor.userId)
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

    #canSee(actor: Actor, job: Job): boolean {
        return hasScope(actor, SCOPES.jobsReadAny) || job.involves(actor.userId)
    }
}
