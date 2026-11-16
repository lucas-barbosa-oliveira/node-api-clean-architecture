import type { JobHandler } from '../application/port/job.handler.ts'
import type { IJobRepository } from '../application/port/job.repository.ts'
import type { IUserRepository } from '../application/port/user.repository.ts'
import { JobService } from '../application/service/job.service.ts'
import { InProcessScheduler } from '../background/scheduler/in.process.scheduler.ts'
import type { BackgroundTask, ITaskScheduler } from '../background/task.ts'
import { InProcessJobQueue } from '../infrastructure/queue/in.process.job.queue.ts'
import type { Env } from './env.ts'

export type Background = {
  jobService: JobService;
  scheduler: ITaskScheduler;
  /** Recuperação na inicialização (chamar antes de aceitar tráfego). */
  recover(): Promise<void>;
  close(): Promise<void>;
}

/** Escolhe fila e agendador pela variável QUEUE_DRIVER (in-process | redis). */
export async function buildBackground(
    env: Env,
    deps: {
    jobRepository: IJobRepository;
    userRepository: IUserRepository;
    handlers: Record<string, JobHandler>;
    makeTasks: (jobService: JobService) => BackgroundTask[];
  },
): Promise<Background> {
    if (env.QUEUE_DRIVER === 'redis') {
        const { RedisConnections } = await import('../infrastructure/redis/redis.connections.ts')
        const { BullMqJobQueue } = await import('../infrastructure/queue/bullmq.job.queue.ts')
        const { BullMqScheduler } = await import('../background/scheduler/bullmq.scheduler.ts')

        const redis = new RedisConnections(env.REDIS_URL)
        const queue = new BullMqJobQueue({
            repo: deps.jobRepository,
            handlers: deps.handlers,
            queueConnection: redis.forQueue(),
            workerConnection: redis.forWorker(),
        })
        const jobService = new JobService(deps.jobRepository, queue, deps.userRepository)
        const scheduler = new BullMqScheduler({
            tasks: deps.makeTasks(jobService),
            queueConnection: redis.forQueue(),
            workerConnection: redis.forWorker(),
        })
        return {
            jobService,
            scheduler,
            recover: async () => {}, // o BullMQ recupera jobs "stalled" sozinho
            close: async () => {
                await scheduler.stop()
                await queue.close()
                await redis.close()
            },
        }
    }

    const queue = new InProcessJobQueue(deps.jobRepository, deps.handlers)
    const jobService = new JobService(deps.jobRepository, queue, deps.userRepository)
    const scheduler = new InProcessScheduler(deps.makeTasks(jobService))
    return {
        jobService,
        scheduler,
        recover: () => jobService.recoverStale(),
        close: async () => {
            await scheduler.stop()
            await queue.close()
        },
    }
}
