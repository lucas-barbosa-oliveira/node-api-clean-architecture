import mongoose, { type Connection } from 'mongoose'
import type { ILogger } from '../../application/port/logger.ts'
import { redactUri, retryUntilConnected } from '../resilience/retry.ts'
import {
    deviceSchema,
    jobSchema,
    outboxEventSchema,
    pairingCodeSchema,
    sessionSchema,
    userSchema,
    type IDeviceModel,
    type IJobModel,
    type IOutboxEventModel,
    type IPairingCodeModel,
    type ISessionModel,
    type IUserModel,
} from './schema/index.ts'

/**
 * Abre uma conexão própria (sem estado global) e compila os models a partir dos schemas.
 * Na inicialização tenta até conseguir; depois disso o driver reconecta sozinho e os eventos viram logs.
 */
// com isto, connection.transaction() repassa a sessão a todas as operações do callback (sem passar { session } à mão)
mongoose.set('transactionAsyncLocalStorage', true)

export async function connectMongo(uri: string, dbName: string, deps: { logger: ILogger; signal?: AbortSignal }) {
    const log = deps.logger
    log.info(`Conectando ao MongoDB em ${redactUri(uri)} (banco "${dbName}")...`)
    const connection = await retryUntilConnected(async () => {
        const attempt = mongoose.createConnection(uri, {
            dbName,
            ignoreUndefined: true,
            serverSelectionTimeoutMS: 5000, // desiste da tentativa (e das consultas, se o banco cair) em 5 s
            heartbeatFrequencyMS: 5000, // frequência com que o driver verifica o servidor e tenta reconectar
        })
        try {
            return await attempt.asPromise()
        } catch (err) {
            await attempt.close().catch(() => {})
            throw err
        }
    }, { name: 'MongoDB', logger: log, signal: deps.signal })
    log.info('Conexão com MongoDB estabelecida')
    const watcher = watchConnection(connection, log)

    const models = {
        User: connection.model<IUserModel>('User', userSchema),
        Job: connection.model<IJobModel>('Job', jobSchema),
        Session: connection.model<ISessionModel>('Session', sessionSchema),
        Device: connection.model<IDeviceModel>('Device', deviceSchema),
        PairingCode: connection.model<IPairingCodeModel>('PairingCode', pairingCodeSchema),
        OutboxEvent: connection.model<IOutboxEventModel>('OutboxEvent', outboxEventSchema),
    }

    // O Mongoose já chama init() ao criar o model; aguardar garante os índices antes de atender requisições.
    await Promise.all(Object.values(models).map(model => model.init()))

    log.info(`Models e índices prontos: ${Object.keys(models).join(', ')}`)

    // transações (outbox junto com o dado) exigem replica set; um mongod avulso funciona, mas sem atomicidade
    const hello = await connection.db?.admin().command({ hello: 1 })
    const supportsTransactions = Boolean(hello?.setName)
    if (supportsTransactions) log.info(`Replica set "${hello?.setName}": transações habilitadas`)
    else log.warn('MongoDB sem replica set: dado e evento do outbox não serão gravados atomicamente (use --replSet)')

    return {
        models,
        connection,
        supportsTransactions,
        /** Verificação do /health/ready: o servidor responde a um ping. */
        ping: async () => {
            await connection.db?.admin().ping()
        },
        close: async () => {
            watcher.closing = true
            await connection.close()
            log.info('Conexão com MongoDB encerrada')
        },
    }
}

/** Transforma os eventos da conexão em logs: queda, cada tentativa de reconexão que falha e o retorno. */
function watchConnection(connection: Connection, log: ILogger) {
    const state = { closing: false, lost: false, failures: 0, lastLogAt: 0 }

    connection.on('disconnected', () => {
        if (state.closing || state.lost) return
        state.lost = true
        state.failures = 0
        state.lastLogAt = 0
        log.warn('Conexão com MongoDB perdida. Tentando reconectar...')
    })
    connection.on('reconnected', () => {
        if (!state.lost) return
        state.lost = false
        log.info(`Conexão com MongoDB restabelecida (após ${state.failures} tentativa(s) sem sucesso)`)
    })
    connection.on('error', (err: Error) => log.error(`Erro na conexão com MongoDB: ${err.message}`))
    // o driver verifica o servidor a cada heartbeatFrequencyMS; durante a queda, cada verificação é uma tentativa
    connection.getClient().on('serverHeartbeatFailed', event => {
        if (!state.lost || state.closing) return
        state.failures++
        // com consultas esperando, o driver verifica a cada 0,5 s: no máximo um log a cada 5 s
        if (Date.now() - state.lastLogAt < 4500) return
        state.lastLogAt = Date.now()
        log.warn(`Tentativa ${state.failures} de reconexão com MongoDB falhou: ${event.failure.message}`)
    })
    return state
}
