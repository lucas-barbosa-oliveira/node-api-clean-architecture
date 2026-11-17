import { Cron } from 'croner'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import { describeSchedule, type BackgroundTask, type ITaskScheduler } from '../task.ts'

/**
 * Agendador em processo (croner). Para uma instância só: com várias instâncias,
 * cada uma dispararia as tasks. Nesse caso use BullMqScheduler.
 */
export class InProcessScheduler implements ITaskScheduler {
    #tasks: BackgroundTask[]
    #timezone: string
    #crons: Cron[] = []
    #active = new Set<string>()
    #inflight = new Set<Promise<void>>()
    #controller = new AbortController()
    #log: ILogger

    constructor(tasks: BackgroundTask[], timezone = 'America/Recife', logger: ILogger = silentLogger) {
        this.#log = logger
        this.#tasks = tasks
        this.#timezone = timezone
    }

    public async start(): Promise<void> {
        for (const task of this.#tasks) {
            if (task.runOnStartup) this.#execute(task)
            if (task.schedule) {
                this.#crons.push(new Cron(task.schedule, { timezone: this.#timezone }, () => this.#execute(task)))
            }
            this.#log.info(`Task ${task.name} configurada (${describeSchedule(task, this.#timezone)})`)
        }
    }

    public async stop(): Promise<void> {
        for (const cron of this.#crons) cron.stop()
        this.#controller.abort()
        await Promise.allSettled([...this.#inflight])
    }

    #execute(task: BackgroundTask): void {
        if (this.#active.has(task.name)) {
            this.#log.warn(`Task ${task.name} ainda em execução; execução ignorada`)
            return
        }
        this.#active.add(task.name)
        const run = (async () => {
            try {
                await task.run(this.#controller.signal)
            } catch (err) {
                this.#log.error(`Task ${task.name} falhou`, { err })
            } finally {
                this.#active.delete(task.name)
            }
        })()
        this.#inflight.add(run)
        run.finally(() => this.#inflight.delete(run))
    }
}
