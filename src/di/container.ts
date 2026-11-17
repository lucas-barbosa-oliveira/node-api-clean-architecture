import { AuditService } from '../application/audit/audit.service.ts'
import type { ILogger } from '../application/port/logger.ts'
import { AuthService } from '../application/service/auth.service.ts'
import { DeviceService } from '../application/service/device.service.ts'
import { PassageService } from '../application/service/passage.service.ts'
import { ReportService } from '../application/service/report.service.ts'
import { UserService } from '../application/service/user.service.ts'
import { buildJobHandlers } from '../background/jobs/handlers.ts'
import { buildTasks } from '../background/tasks/index.ts'
import { JwtTokenService } from '../infrastructure/security/jwt.token.service.ts'
import { RefreshTokenCodec } from '../infrastructure/security/refresh.token.codec.ts'
import { ScryptPasswordHasher } from '../infrastructure/security/scrypt.password.hasher.ts'
import { loadSigningKeys } from '../infrastructure/security/signing.keys.ts'
import { buildBackground } from './background.ts'
import { loadEnv, type Env } from './env.ts'
import { buildEventBus } from './event.bus.ts'
import { buildLogger } from './logger.ts'
import { buildRepositories } from './repositories.ts'
import { buildPassageStore } from './timeseries.ts'

/** Composition root: o único lugar que conhece todas as camadas e liga as peças. */
export async function buildContainer(
    env: Env = loadEnv(),
    options: { logger?: ILogger; signal?: AbortSignal } = {},
) {
    const logger = options.logger ?? buildLogger(env)
    const { repos, close: closeRepos } = await buildRepositories(env, { logger, signal: options.signal })

    const hasher = new ScryptPasswordHasher()
    const tokens = new JwtTokenService({
        ...(await loadSigningKeys(
            { privateKeyPath: env.JWT_PRIVATE_KEY_PATH, publicKeyPath: env.JWT_PUBLIC_KEY_PATH },
            logger.child('auth'),
        )),
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        expiresInSeconds: env.JWT_EXPIRES_IN_SECONDS,
    })

    const deviceService = new DeviceService({
        devices: repos.deviceRepository,
        pairingCodes: repos.pairingCodeRepository,
        users: repos.userRepository,
        tokens,
        pairingCodeTtlSeconds: env.PAIRING_CODE_TTL_SECONDS,
        deviceTokenTtlSeconds: env.DEVICE_TOKEN_TTL_SECONDS,
    })
    const passageStore = await buildPassageStore(env, logger)
    const eventBus = await buildEventBus(env, logger)

    const authService = new AuthService({
        users: repos.userRepository,
        sessions: repos.sessionRepository,
        hasher,
        tokens,
        refreshTokens: new RefreshTokenCodec(),
        refreshTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
        isDeviceActive: (deviceId, clientId) => deviceService.isActive(deviceId, clientId),
    })

    const background = await buildBackground(env, {
        jobRepository: repos.jobRepository,
        userRepository: repos.userRepository,
        handlers: buildJobHandlers({ reportService: new ReportService(env.REPORT_DURATION_MS) }),
        makeTasks: jobService => buildTasks({ jobService, authService, logger }),
        logger,
    })

    const userService = new UserService(repos.userRepository, hasher)

    return {
        logger,
        eventBus,
        /** Auditoria por requisição (null com AUDIT_ENABLED=false). */
        audit: env.AUDIT_ENABLED
            ? {
                service: new AuditService({
                    bus: eventBus,
                    service: env.APP_NAME,
                    maxBodyBytes: env.AUDIT_MAX_BODY_BYTES,
                    logger: logger.child('audit'),
                }),
                ignorePaths: env.AUDIT_IGNORE_PATHS,
            }
            : null,
        apiDocs: env.API_DOCS_ENABLED ? { title: env.APP_NAME } : null,
        authService,
        userService,
        deviceService,
        passageService: new PassageService(passageStore, repos.deviceRepository),
        jobService: background.jobService,
        scheduler: background.scheduler,
        recover: background.recover,
        /** Cria o administrador inicial definido em ADMIN_EMAIL/ADMIN_PASSWORD (se houver). */
        ensureAdmin: async () => {
            if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
                logger.child('auth').warn('ADMIN_EMAIL/ADMIN_PASSWORD não definidos: nenhum administrador inicial foi criado')
                return
            }
            await userService.ensureAdmin({ name: env.ADMIN_NAME, email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })
        },
        /** Encerra na ordem inversa da dependência: quem produz trabalho primeiro, conexões por último. */
        close: async () => {
            await background.close()
            await eventBus.close()
            await passageStore.close()
            await closeRepos()
        },
    }
}

export type Container = Awaited<ReturnType<typeof buildContainer>>
