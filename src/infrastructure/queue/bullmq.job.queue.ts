import { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import type { ILogger } from '../../application/port/logger.ts'
import { silentLogger } from '../../application/port/logger.ts'
import type { JobHandler } from '../../application/port/job.handler.ts'
import type { IJobQueue } from '../../application/port/job.queue.ts'
import type { IJobRepository } from '../../application/port/job.repository.ts'
import { onQueueError } from './queue.errors.ts'
import { runJob } from './run.job.ts'

const QUEUE_NAME = 'jobs'

/**
 * Fila durável e compartilhada (Redis). Qualquer instância enfileira; um worker de alguma instância processa.
 * O estado visível ao usuário continua no IJobRepository (precisa ser compartilhado, ex.: Mongo).
 */
export class BullMqJobQueue implements IJobQueue {
    #queue: Queue
    #worker: Worker

    constructor(deps: {
    repo: IJobRepository;
    handlers: Record<string, JobHandler>;
    queueConnection: Redis;
    workerConnection: Redis;
    concurrency?: number;
    queueName?: string;
    /** Prefixo das chaves no Redis (padrão do BullMQ: bull). */
    prefix?: string;
    logger?: ILogger;
  }) {
        const log = deps.logger ?? silentLogger
        const name = deps.queueName ?? QUEUE_NAME
        this.#queue = new Queue(name, { connection: deps.queueConnection, prefix: deps.prefix })
        this.#worker = new Worker(
            name,
            // erros de negócio viram status "failed" dentro do runJob; erros de infra sobem e o BullMQ tenta de novo
            async bullJob => {
                await runJob(deps.repo, deps.handlers, bullJob.data.jobId)
            },
            { connection: deps.workerConnection, concurrency: deps.concurrency ?? 2, prefix: deps.prefix },
        )
        this.#queue.on('error', onQueueError(log, `Erro na fila "${name}"`))
        this.#worker.on('error', onQueueError(log, `Erro no worker da fila "${name}"`))
        this.#worker.on('failed', (job, err) =>
            log.warn(`Job ${job?.data.jobId} falhou na fila "${name}" (tentativa ${job?.attemptsMade}): ${err.message}`))
        log.info(`Fila de jobs "${name}" configurada (BullMQ, concorrência ${deps.concurrency ?? 2})`)
    }

    public async enqueue(jobId: string): Promise<void> {
    // jobId = id do nosso Job: enfileirar duas vezes não duplica a execução
        await this.#queue.add(
            'run',
            { jobId },
            {
                jobId,
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
                removeOnComplete: { age: 3600 },
                removeOnFail: { age: 86_400 },
            },
        )
    }

    public async close(): Promise<void> {
        await this.#worker.close() // espera os jobs ativos terminarem
        await this.#queue.close()
    }
}
