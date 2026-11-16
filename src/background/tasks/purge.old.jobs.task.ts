import type { JobService } from '../../application/service/job.service.ts'
import type { BackgroundTask } from '../task.ts'

/** Remove jobs finalizados há mais de 7 dias. Roda ao iniciar e todo dia às 03:00. */
export function purgeOldJobsTask(jobService: JobService): BackgroundTask {
    return {
        name: 'purge-old-jobs',
        runOnStartup: true,
        schedule: '0 3 * * *',
        run: async () => {
            const removed = await jobService.purgeOlderThan(7)
            console.log(`[purge-old-jobs] ${removed} job(s) removido(s)`)
        },
    }
}
