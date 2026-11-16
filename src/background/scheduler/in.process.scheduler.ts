import { Cron } from 'croner'
import type { BackgroundTask, ITaskScheduler } from '../task.ts'

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

    constructor(tasks: BackgroundTask[], timezone = 'America/Recife') {
        this.#tasks = tasks
        this.#timezone = timezone
    }

    public async start(): Promise<void> {
        for (const task of this.#tasks) {
            if (task.runOnStartup) this.#execute(task)
            if (task.schedule) {
                this.#crons.push(new Cron(task.schedule, { timezone: this.#timezone }, () => this.#execute(task)))
            }
        }
    }

    public async stop(): Promise<void> {
        for (const cron of this.#crons) cron.stop()
        this.#controller.abort()
        await Promise.allSettled([...this.#inflight])
    }

    #execute(task: BackgroundTask): void {
        if (this.#active.has(task.name)) {
            console.warn(`[${task.name}] ainda em execução; execução ignorada`)
            return
        }
        this.#active.add(task.name)
        const run = (async () => {
            try {
                await task.run(this.#controller.signal)
            } catch (err) {
                console.error(`[${task.name}] falhou`, err)
            } finally {
                this.#active.delete(task.name)
            }
        })()
        this.#inflight.add(run)
        run.finally(() => this.#inflight.delete(run))
    }
}
