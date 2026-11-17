import type { HealthCheck } from '../application/port/health.check.ts'
import type { ILogger } from '../application/port/logger.ts'
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
  healthChecks: HealthCheck[];
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
    logger: ILogger;
  },
): Promise<Background> {
    if (env.QUEUE_DRIVER === 'redis') {
        const { RedisConnections } = await import('../infrastructure/redis/redis.connections.ts')
        const { BullMqJobQueue } = await import('../infrastructure/queue/bullmq.job.queue.ts')
        const { BullMqScheduler } = await import('../background/scheduler/bullmq.scheduler.ts')

        const redis = new RedisConnections(env.REDIS_URL, deps.logger.child('redis'))
        const queue = new BullMqJobQueue({
            repo: deps.jobRepository,
            handlers: deps.handlers,
            queueConnection: redis.forQueue('jobs:queue'),
            workerConnection: redis.forWorker('jobs:worker'),
            logger: deps.logger.child('jobs'),
            prefix: env.QUEUE_PREFIX,
        })
        const jobService = new JobService(deps.jobRepository, queue, deps.userRepository)
        const scheduler = new BullMqScheduler({
            tasks: deps.makeTasks(jobService),
            queueConnection: redis.forQueue('tasks:queue'),
            workerConnection: redis.forWorker('tasks:worker'),
            logger: deps.logger.child('scheduler'),
            prefix: env.QUEUE_PREFIX,
        })
        await redis.ready()
        return {
            jobService,
            scheduler,
            recover: async () => {}, // o BullMQ recupera jobs "stalled" sozinho
            healthChecks: [{
                name: 'redis',
                critical: true, // sem Redis não há como enfileirar jobs
                check: async () => {
                    const connections = redis.status()
                    const up = Object.values(connections).every(status => status === 'ready')
                    return { status: up ? 'up' : 'down', details: connections }
                },
            }],
            close: async () => {
                await scheduler.stop()
                await queue.close()
                await redis.close()
            },
        }
    }

    const queue = new InProcessJobQueue(deps.jobRepository, deps.handlers, 2, deps.logger.child('jobs'))
    deps.logger.child('jobs').info('Fila de jobs em processo configurada (memória, concorrência 2)')
    const jobService = new JobService(deps.jobRepository, queue, deps.userRepository)
    const scheduler = new InProcessScheduler(deps.makeTasks(jobService), undefined, deps.logger.child('scheduler'))
    return {
        jobService,
        scheduler,
        recover: () => jobService.recoverStale(),
        healthChecks: [],
        close: async () => {
            await scheduler.stop()
            await queue.close()
        },
    }
}
