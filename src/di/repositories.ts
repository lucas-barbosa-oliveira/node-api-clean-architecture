import type { ILogger } from '../application/port/logger.ts'
import type { IDeviceRepository } from '../application/port/device.repository.ts'
import type { IJobRepository } from '../application/port/job.repository.ts'
import type { IPairingCodeRepository } from '../application/port/pairing.code.repository.ts'
import type { ISessionRepository } from '../application/port/session.repository.ts'
import type { IUserRepository } from '../application/port/user.repository.ts'
import { InMemoryDeviceRepository } from '../infrastructure/repository/in-memory/in.memory.device.repository.ts'
import { InMemoryJobRepository } from '../infrastructure/repository/in-memory/in.memory.job.repository.ts'
import { InMemoryPairingCodeRepository } from '../infrastructure/repository/in-memory/in.memory.pairing.code.repository.ts'
import { InMemorySessionRepository } from '../infrastructure/repository/in-memory/in.memory.session.repository.ts'
import { InMemoryUserRepository } from '../infrastructure/repository/in-memory/in.memory.user.repository.ts'
import type { Env } from './env.ts'

export type Repositories = {
    userRepository: IUserRepository;
    jobRepository: IJobRepository;
    sessionRepository: ISessionRepository;
    deviceRepository: IDeviceRepository;
    pairingCodeRepository: IPairingCodeRepository;
}

/** Escolhe a infraestrutura de persistência pela variável REPOSITORY_DRIVER (memory | mongo). */
export async function buildRepositories(
    env: Env,
    deps: { logger: ILogger; signal?: AbortSignal },
): Promise<{ repos: Repositories; close(): Promise<void> }> {
    if (env.REPOSITORY_DRIVER === 'mongo') {
    // imports dinâmicos: o Mongoose só é carregado quando o driver mongo é usado
        const { connectMongo } = await import('../infrastructure/database/mongo.database.ts')
        const { MongoUserRepository } = await import('../infrastructure/repository/mongo/mongo.user.repository.ts')
        const { MongoJobRepository } = await import('../infrastructure/repository/mongo/mongo.job.repository.ts')
        const { MongoSessionRepository } = await import('../infrastructure/repository/mongo/mongo.session.repository.ts')
        const { MongoDeviceRepository } = await import('../infrastructure/repository/mongo/mongo.device.repository.ts')
        const { MongoPairingCodeRepository } = await import('../infrastructure/repository/mongo/mongo.pairing.code.repository.ts')

        const db = await connectMongo(env.MONGO_URI, env.MONGO_DB, { logger: deps.logger.child('mongodb'), signal: deps.signal })
        return {
            repos: {
                userRepository: new MongoUserRepository(db.models.User),
                jobRepository: new MongoJobRepository(db.models.Job),
                sessionRepository: new MongoSessionRepository(db.models.Session),
                deviceRepository: new MongoDeviceRepository(db.models.Device),
                pairingCodeRepository: new MongoPairingCodeRepository(db.models.PairingCode),
            },
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
        },
        close: async () => {},
    }
}
