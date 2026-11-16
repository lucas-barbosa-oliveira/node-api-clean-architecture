import { Queue, Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import type { BackgroundTask, ITaskScheduler } from '../task.ts'

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

    constructor(deps: {
    tasks: BackgroundTask[];
    queueConnection: Redis;
    workerConnection: Redis;
    timezone?: string;
    queueName?: string;
  }) {
        const name = deps.queueName ?? QUEUE_NAME
        this.#tasks = new Map(deps.tasks.map(task => [task.name, task]))
        this.#timezone = deps.timezone ?? 'America/Recife'
        this.#queue = new Queue(name, { connection: deps.queueConnection })
        this.#worker = new Worker(
            name,
            async job => {
                await this.#tasks.get(job.name)?.run(this.#controller.signal)
            },
            // autorun: false => só começa a consumir depois que os schedulers estiverem registrados
            { connection: deps.workerConnection, concurrency: 1, autorun: false },
        )
        this.#worker.on('error', err => console.error('[tasks worker]', err))
        this.#worker.on('failed', (job, err) => console.error(`[${job?.name}] falhou`, err))
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
            if (task.runOnStartup) {
                await this.#queue.add(
                    task.name,
                    {},
                    { deduplication: { id: `startup:${task.name}`, ttl: STARTUP_DEDUP_TTL_MS } },
                )
            }
        }
        this.#worker.run().catch(err => console.error('[tasks worker]', err))
    }

    public async stop(): Promise<void> {
        this.#controller.abort()
        await this.#worker.close()
        await this.#queue.close()
    }
}
