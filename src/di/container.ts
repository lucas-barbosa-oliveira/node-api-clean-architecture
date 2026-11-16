import { ReportService } from '../application/service/report.service.ts'
import { UserService } from '../application/service/user.service.ts'
import { buildJobHandlers } from '../background/jobs/handlers.ts'
import { buildTasks } from '../background/tasks/index.ts'
import { buildBackground } from './background.ts'
import { loadEnv, type Env } from './env.ts'
import { buildRepositories } from './repositories.ts'

/** Composition root: o único lugar que conhece todas as camadas e liga as peças. */
export async function buildContainer(env: Env = loadEnv()) {
    const { repos, close: closeRepos } = await buildRepositories(env)

    const background = await buildBackground(env, {
        jobRepository: repos.jobRepository,
        handlers: buildJobHandlers({ reportService: new ReportService(env.REPORT_DURATION_MS) }),
        makeTasks: jobService => buildTasks({ jobService }),
    })

    return {
        userService: new UserService(repos.userRepository),
        jobService: background.jobService,
        scheduler: background.scheduler,
        recover: background.recover,
        close: async () => {
            await background.close()
            await closeRepos()
        },
    }
}

export type Container = Awaited<ReturnType<typeof buildContainer>>
