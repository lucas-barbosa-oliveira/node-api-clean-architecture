import type { IDeviceRepository } from '../application/port/device.repository.ts'
import type { HealthCheck } from '../application/port/health.check.ts'
import type { IJobRepository } from '../application/port/job.repository.ts'
import type { ILogger } from '../application/port/logger.ts'
import type { IOutbox } from '../application/port/outbox.ts'
import type { IMfaChallengeRepository } from '../application/port/mfa.challenge.repository.ts'
import type { IPairingCodeRepository } from '../application/port/pairing.code.repository.ts'
import type { ISessionRepository } from '../application/port/session.repository.ts'
import { noTransaction, type IUnitOfWork } from '../application/port/unit.of.work.ts'
import type { IUserRepository } from '../application/port/user.repository.ts'
import { InMemoryOutbox } from '../infrastructure/outbox/in.memory.outbox.ts'
import type { IOutboxStore } from '../infrastructure/outbox/outbox.store.ts'
import { InMemoryDeviceRepository } from '../infrastructure/repository/in-memory/in.memory.device.repository.ts'
import { InMemoryJobRepository } from '../infrastructure/repository/in-memory/in.memory.job.repository.ts'
import { InMemoryMfaChallengeRepository } from '../infrastructure/repository/in-memory/in.memory.mfa.challenge.repository.ts'
import { InMemoryPairingCodeRepository } from '../infrastructure/repository/in-memory/in.memory.pairing.code.repository.ts'
import { InMemorySessionRepository } from '../infrastructure/repository/in-memory/in.memory.session.repository.ts'
import { InMemoryUserRepository } from '../infrastructure/repository/in-memory/in.memory.user.repository.ts'
import type { Reloadable } from '../infrastructure/secrets/secret.file.watcher.ts'
import type { Env } from './env.ts'
import { currentSecret, watchedFiles } from './secrets.ts'

export type Repositories = {
    userRepository: IUserRepository;
    jobRepository: IJobRepository;
    sessionRepository: ISessionRepository;
    deviceRepository: IDeviceRepository;
    pairingCodeRepository: IPairingCodeRepository;
    mfaChallengeRepository: IMfaChallengeRepository;
}

export type Persistence = {
    repos: Repositories;
    /** Escrita (services) e leitura (relay) do outbox, no mesmo banco dos dados. */
    outbox: IOutbox & IOutboxStore & { onAdd(listener: () => void): void };
    unitOfWork: IUnitOfWork;
    healthChecks: HealthCheck[];
    /** Reconfiguração quando credenciais ou certificados mudam em disco. */
    reloadables: Reloadable[];
    close(): Promise<void>;
}

/** Escolhe a infraestrutura de persistência pela variável REPOSITORY_DRIVER (memory | mongo). */
export async function buildRepositories(env: Env, deps: { logger: ILogger; signal?: AbortSignal }): Promise<Persistence> {
    if (env.REPOSITORY_DRIVER === 'mongo') {
        // imports dinâmicos: o Mongoose só é carregado quando o driver mongo é usado
        const { connectMongo } = await import('../infrastructure/database/mongo.database.ts')
        const { MongoUnitOfWork } = await import('../infrastructure/database/mongo.unit.of.work.ts')
        const { MongoOutbox } = await import('../infrastructure/outbox/mongo.outbox.ts')
        const { MongoUserRepository } = await import('../infrastructure/repository/mongo/mongo.user.repository.ts')
        const { MongoJobRepository } = await import('../infrastructure/repository/mongo/mongo.job.repository.ts')
        const { MongoSessionRepository } = await import('../infrastructure/repository/mongo/mongo.session.repository.ts')
        const { MongoDeviceRepository } = await import('../infrastructure/repository/mongo/mongo.device.repository.ts')
        const { MongoPairingCodeRepository } = await import('../infrastructure/repository/mongo/mongo.pairing.code.repository.ts')
        const { MongoMfaChallengeRepository } = await import(
            '../infrastructure/repository/mongo/mongo.mfa.challenge.repository.ts'
        )

        const mongoEnv = env
        // credenciais atuais (relidas dos arquivos a cada chamada): usuário dinâmico do Vault ou fixo
        const credentials = () => {
            const username = currentSecret(mongoEnv, 'MONGO_USERNAME')
            const password = currentSecret(mongoEnv, 'MONGO_PASSWORD')
            return username && password ? { username, password, authSource: mongoEnv.MONGO_AUTH_SOURCE } : undefined
        }
        const db = await connectMongo(env.MONGO_URI, env.MONGO_DB, {
            logger: deps.logger.child('mongodb'),
            signal: deps.signal,
            tls: env.tls.mongo,
            credentials: credentials(),
            autoIndex: env.MONGO_AUTO_INDEX,
        })
        return {
            repos: {
                userRepository: new MongoUserRepository(db.models.User),
                jobRepository: new MongoJobRepository(db.models.Job),
                sessionRepository: new MongoSessionRepository(db.models.Session),
                deviceRepository: new MongoDeviceRepository(db.models.Device),
                pairingCodeRepository: new MongoPairingCodeRepository(db.models.PairingCode),
                mfaChallengeRepository: new MongoMfaChallengeRepository(db.models.MfaChallenge),
            },
            outbox: new MongoOutbox(db.models.OutboxEvent),
            unitOfWork: db.supportsTransactions ? new MongoUnitOfWork(db.connection) : noTransaction,
            healthChecks: [{
                name: 'mongodb',
                critical: true,
                check: async () => {
                    await db.ping()
                    return { status: 'up', details: { transactions: db.supportsTransactions } }
                },
            }],
            reloadables: [{
                name: 'mongodb',
                files: watchedFiles(env, ['MONGO_URI', 'MONGO_USERNAME', 'MONGO_PASSWORD'], env.tls.mongo),
                reload: () => db.reconnect({
                    uri: currentSecret(mongoEnv, 'MONGO_URI') ?? mongoEnv.MONGO_URI,
                    credentials: credentials(),
                    tls: mongoEnv.tls.mongo,
                }),
            }],
            close: () => db.close(),
        }
    }

    deps.logger.child('repositories').info('Repositórios em memória (REPOSITORY_DRIVER=memory): os dados somem ao reiniciar')
    return {
        repos: {
            userRepository: new InMemoryUserRepository(),
            jobRepository: new InMemoryJobRepository(),
            sessionRepository: new InMemorySessionRepository(),
            deviceRepository: new InMemoryDeviceRepository(),
            pairingCodeRepository: new InMemoryPairingCodeRepository(),
            mfaChallengeRepository: new InMemoryMfaChallengeRepository(),
        },
        outbox: new InMemoryOutbox(),
        unitOfWork: noTransaction,
        healthChecks: [],
        reloadables: [],
        close: async () => {},
    }
}
