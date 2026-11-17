import { AuditService } from '../application/audit/audit.service.ts'
import type { ILogger } from '../application/port/logger.ts'
import { HealthService } from '../application/service/health.service.ts'
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
import { OutboxRelay } from '../infrastructure/outbox/outbox.relay.ts'
import { isDependencyUnavailable } from '../infrastructure/resilience/unavailable.ts'
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
    const persistence = await buildRepositories(env, { logger, signal: options.signal })
    const { repos, outbox, unitOfWork } = persistence

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
        outbox,
        unitOfWork,
    })
    const timeseries = await buildPassageStore(env, logger)
    const passageStore = timeseries.store
    const eventBus = await buildEventBus(env, logger)
    const outboxRelay = new OutboxRelay({
        store: outbox,
        bus: eventBus,
        logger: logger.child('outbox'),
        pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    })
    outbox.onAdd(() => outboxRelay.notify())

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

    const userService = new UserService(repos.userRepository, hasher, { outbox, unitOfWork })

    const health = new HealthService([
        ...persistence.healthChecks,
        ...background.healthChecks,
        ...timeseries.healthChecks,
        {
            name: 'rabbitmq',
            critical: false, // fora do ar, os eventos esperam no outbox
            check: async () => {
                const connections = eventBus.status()
                return { status: Object.values(connections).every(Boolean) ? 'up' : 'down', details: connections }
            },
        },
        {
            name: 'outbox',
            critical: false,
            check: async () => {
                const stats = await outboxRelay.stats()
                // eventos parados há mais de 5 minutos indicam barramento fora do ar ou evento rejeitado
                return { status: stats.oldestAgeSeconds > 300 ? 'down' : 'up', details: stats }
            },
        },
    ])

    return {
        logger,
        eventBus,
        outboxRelay,
        health,
        /** Reconhece erros de dependência fora do ar (respondidos com 503). */
        isDependencyUnavailable,
        /** Auditoria por requisição (null com AUDIT_ENABLED=false). */
        audit: env.AUDIT_ENABLED
            ? {
                service: new AuditService({
                    outbox,
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
            await outboxRelay.stop() // o que não saiu fica no banco e sai na próxima execução
            await eventBus.close()
            await passageStore.close()
            await persistence.close()
        },
    }
}

export type Container = Awaited<ReturnType<typeof buildContainer>>
