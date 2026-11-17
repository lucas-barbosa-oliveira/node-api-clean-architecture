import { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import { onQueueError } from '../../infrastructure/queue/queue.errors.ts'
import { describeSchedule, type BackgroundTask, type ITaskScheduler } from '../task.ts'

const QUEUE_NAME = 'background-tasks'
const STARTUP_DEDUP_TTL_MS = 60_000

/**
 * Agendador distribuído (Redis). Com várias instâncias:
 * - cada disparo cron roda uma única vez no cluster (Job Schedulers);
 * - nunca há duas tasks em paralelo (global concurrency = 1);
 * - tasks de startup não repetem em cada instância (deduplicação por janela de tempo).
 */
export class BullMqScheduler implements ITaskScheduler {
    #tasks: Map<string, BackgroundTask>
    #timezone: string
    #queue: Queue
    #worker: Worker
    #controller = new AbortController()
    #log: ILogger

    constructor(deps: {
    tasks: BackgroundTask[];
    queueConnection: Redis;
    workerConnection: Redis;
    timezone?: string;
    queueName?: string;
    /** Prefixo das chaves no Redis (padrão do BullMQ: bull). */
    prefix?: string;
    logger?: ILogger;
  }) {
        this.#log = deps.logger ?? silentLogger
        const name = deps.queueName ?? QUEUE_NAME
        this.#tasks = new Map(deps.tasks.map(task => [task.name, task]))
        this.#timezone = deps.timezone ?? 'America/Recife'
        this.#queue = new Queue(name, { connection: deps.queueConnection, prefix: deps.prefix })
        this.#worker = new Worker(
            name,
            async job => {
                await this.#tasks.get(job.name)?.run(this.#controller.signal)
            },
            // autorun: false => só começa a consumir depois que os schedulers estiverem registrados
            { connection: deps.workerConnection, concurrency: 1, autorun: false, prefix: deps.prefix },
        )
        this.#queue.on('error', onQueueError(this.#log, 'Erro na fila de tasks'))
        this.#worker.on('error', onQueueError(this.#log, 'Erro no worker de tasks'))
        this.#worker.on('failed', (job, err) => this.#log.error(`Task ${job?.name} falhou`, { err }))
    }

    public async start(): Promise<void> {
        await this.#queue.setGlobalConcurrency(1)
        for (const task of this.#tasks.values()) {
            if (task.schedule) {
                await this.#queue.upsertJobScheduler(
                    task.name,
                    { pattern: task.schedule, tz: this.#timezone },
                    { name: task.name, data: {} },
                )
            }
            this.#log.info(`Task ${task.name} configurada (${describeSchedule(task, this.#timezone)})`)
            if (task.runOnStartup) {
                await this.#queue.add(
                    task.name,
                    {},
                    { deduplication: { id: `startup:${task.name}`, ttl: STARTUP_DEDUP_TTL_MS } },
                )
            }
        }
        this.#worker.run().catch(err => this.#log.error('Worker de tasks parou', { err }))
    }

    public async stop(): Promise<void> {
        this.#controller.abort()
        await this.#worker.close()
        await this.#queue.close()
    }
}
