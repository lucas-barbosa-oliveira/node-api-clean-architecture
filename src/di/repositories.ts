import type { IJobRepository } from '../application/port/job.repository.ts'
import type { IUserRepository } from '../application/port/user.repository.ts'
import { InMemoryJobRepository } from '../infrastructure/repository/in-memory/in.memory.job.repository.ts'
import { InMemoryUserRepository } from '../infrastructure/repository/in-memory/in.memory.user.repository.ts'
import type { Env } from './env.ts'

export type Repositories = { userRepository: IUserRepository; jobRepository: IJobRepository }

/** Escolhe a infraestrutura de persistência pela variável REPOSITORY_DRIVER (memory | mongo). */
export async function buildRepositories(env: Env): Promise<{ repos: Repositories; close(): Promise<void> }> {
    if (env.REPOSITORY_DRIVER === 'mongo') {
    // imports dinâmicos: o Mongoose só é carregado quando o driver mongo é usado
        const { connectMongo } = await import('../infrastructure/database/mongo.database.ts')
        const { MongoUserRepository } = await import('../infrastructure/repository/mongo/mongo.user.repository.ts')
        const { MongoJobRepository } = await import('../infrastructure/repository/mongo/mongo.job.repository.ts')

        const db = await connectMongo(env.MONGO_URI, env.MONGO_DB)
        return {
            repos: {
                userRepository: new MongoUserRepository(db.models.User),
                jobRepository: new MongoJobRepository(db.models.Job),
            },
            close: () => db.close(),
        }
    }

    return {
        repos: { userRepository: new InMemoryUserRepository(), jobRepository: new InMemoryJobRepository() },
        close: async () => {},
    }
}
