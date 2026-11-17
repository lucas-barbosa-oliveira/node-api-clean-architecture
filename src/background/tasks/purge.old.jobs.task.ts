import type { ILogger } from '../../application/port/logger.ts'
import type { JobService } from '../../application/service/job.service.ts'
import type { BackgroundTask } from '../task.ts'

/** Remove jobs finalizados há mais de 7 dias. Roda ao iniciar e todo dia às 03:00. */
export function purgeOldJobsTask(jobService: JobService, log: ILogger): BackgroundTask {
    return {
        name: 'purge-old-jobs',
        runOnStartup: true,
        schedule: '0 3 * * *',
        run: async () => {
            const removed = await jobService.purgeOlderThan(7)
            log.info(`${removed} job(s) removido(s)`)
        },
    }
}
