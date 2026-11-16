import type { JobService } from '../../application/service/job.service.ts'
import type { BackgroundTask } from '../task.ts'
import { purgeOldJobsTask } from './purge.old.jobs.task.ts'

/** Registre aqui cada nova task. */
export function buildTasks(deps: { jobService: JobService }): BackgroundTask[] {
    return [purgeOldJobsTask(deps.jobService)]
}
