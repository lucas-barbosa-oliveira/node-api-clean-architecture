import type { ILogger } from '../../application/port/logger.ts'
import type { AuthService } from '../../application/service/auth.service.ts'
import type { JobService } from '../../application/service/job.service.ts'
import type { BackgroundTask } from '../task.ts'
import { purgeEndedSessionsTask } from './purge.ended.sessions.task.ts'
import { purgeOldJobsTask } from './purge.old.jobs.task.ts'

/** Registre aqui cada nova task. */
export function buildTasks(deps: { jobService: JobService; authService: AuthService; logger: ILogger }): BackgroundTask[] {
    return [
        purgeOldJobsTask(deps.jobService, deps.logger.child('purge-old-jobs')),
        purgeEndedSessionsTask(deps.authService, deps.logger.child('purge-ended-sessions')),
    ]
}
