/**
 * Migração de índices do MongoDB, fora da inicialização da API (job do deploy: hook pre-install/pre-upgrade do Helm).
 *
 *   npm run db:migrate             cria os índices que faltam (não remove nada)
 *   npm run db:migrate -- --drop   também remove os índices que não estão mais nos schemas
 *
 * Com os índices criados aqui, as instâncias sobem com MONGO_AUTO_INDEX=false: várias réplicas não disputam a criação
 * de índices, e um índice demorado não atrasa a readiness.
 */
import { connectMongo, migrateIndexes } from '../infrastructure/database/mongo.database.ts'
import { loadEnv } from '../di/env.ts'
import { buildLogger } from '../di/logger.ts'
import { currentSecret } from '../di/secrets.ts'

const env = loadEnv()
const log = buildLogger(env).child('migrate')

if (env.REPOSITORY_DRIVER !== 'mongo') {
    log.info('REPOSITORY_DRIVER não é mongo: nada a migrar')
    process.exit(0)
}

const username = currentSecret(env, 'MONGO_USERNAME')
const password = currentSecret(env, 'MONGO_PASSWORD')
const db = await connectMongo(env.MONGO_URI, env.MONGO_DB, {
    logger: log,
    tls: env.tls.mongo,
    credentials: username && password ? { username, password, authSource: env.MONGO_AUTH_SOURCE } : undefined,
    autoIndex: false,
})
try {
    const drop = process.argv.includes('--drop')
    const report = await migrateIndexes(db.models as never, { drop })
    for (const [model, { created, dropped }] of Object.entries(report)) {
        const changes = [
            ...created.map(index => `+ ${index}`),
            ...dropped.map(index => `- ${index}`),
        ]
        log.info(`${model}: ${changes.length ? changes.join(', ') : 'nenhuma mudança'}`)
    }
    log.info(`Índices em dia (banco "${env.MONGO_DB}"${drop ? ', com remoção dos obsoletos' : ''})`)
} finally {
    await db.close()
}
