import { AuthService } from '../application/service/auth.service.ts'
import { ReportService } from '../application/service/report.service.ts'
import { UserService } from '../application/service/user.service.ts'
import { buildJobHandlers } from '../background/jobs/handlers.ts'
import { buildTasks } from '../background/tasks/index.ts'
import { JwtTokenService } from '../infrastructure/security/jwt.token.service.ts'
import { ScryptPasswordHasher } from '../infrastructure/security/scrypt.password.hasher.ts'
import { loadSigningKeys } from '../infrastructure/security/signing.keys.ts'
import { buildBackground } from './background.ts'
import { loadEnv, type Env } from './env.ts'
import { buildRepositories } from './repositories.ts'

/** Composition root: o único lugar que conhece todas as camadas e liga as peças. */
export async function buildContainer(env: Env = loadEnv()) {
    const { repos, close: closeRepos } = await buildRepositories(env)

    const hasher = new ScryptPasswordHasher()
    const tokens = new JwtTokenService({
        ...(await loadSigningKeys({ privateKeyPath: env.JWT_PRIVATE_KEY_PATH, publicKeyPath: env.JWT_PUBLIC_KEY_PATH })),
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        expiresInSeconds: env.JWT_EXPIRES_IN_SECONDS,
    })

    const background = await buildBackground(env, {
        jobRepository: repos.jobRepository,
        userRepository: repos.userRepository,
        handlers: buildJobHandlers({ reportService: new ReportService(env.REPORT_DURATION_MS) }),
        makeTasks: jobService => buildTasks({ jobService }),
    })

    const userService = new UserService(repos.userRepository, hasher)

    return {
        authService: new AuthService(repos.userRepository, hasher, tokens),
        userService,
        jobService: background.jobService,
        scheduler: background.scheduler,
        recover: background.recover,
        /** Cria o administrador inicial definido em ADMIN_EMAIL/ADMIN_PASSWORD (se houver). */
        ensureAdmin: async () => {
            if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
                console.warn('[auth] ADMIN_EMAIL/ADMIN_PASSWORD não definidos: nenhum administrador inicial foi criado')
                return
            }
            await userService.ensureAdmin({ name: env.ADMIN_NAME, email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })
        },
        close: async () => {
            await background.close()
            await closeRepos()
        },
    }
}

export type Container = Awaited<ReturnType<typeof buildContainer>>
