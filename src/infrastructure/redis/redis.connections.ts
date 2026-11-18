import { Redis } from 'ioredis'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import { redactUri } from '../resilience/retry.ts'
import { describeTls, readTlsClientOptions, type TlsClientConfig, type TlsClientOptions } from '../security/tls.ts'

type Tracked = { name: string; connection: Redis; ready: Promise<void> }
/** Substituem os da URL (ex.: senha guardada no Vault). */
export type RedisCredentials = { username?: string; password?: string }

/**
 * Cria e fecha as conexões Redis usadas pelo BullMQ (filas e workers).
 * O ioredis reconecta sozinho, para sempre; os eventos de cada conexão viram logs.
 */
export class RedisConnections {
    #url: string
    #log: ILogger
    #all: Tracked[] = []
    #closing = false
    #tlsConfig?: TlsClientConfig
    #tls?: TlsClientOptions
    #credentials?: RedisCredentials

    constructor(url: string, logger: ILogger = silentLogger, tls?: TlsClientConfig, credentials?: RedisCredentials) {
        this.#url = url
        this.#log = logger
        this.#tlsConfig = tls
        this.#tls = tls && readTlsClientOptions(tls)
        this.#credentials = credentials
    }

    /**
     * Troca senha e certificados (renovados em disco): atualiza as opções e refaz cada conexão. O ioredis reconecta
     * sozinho e os comandos em andamento são reenviados; o BullMQ não percebe.
     */
    public reconfigure(settings: { tls?: TlsClientConfig; credentials?: RedisCredentials }): void {
        const tls = settings.tls && readTlsClientOptions(settings.tls) // lê antes: se falhar, nada muda
        this.#tls = tls
        this.#tlsConfig = settings.tls
        this.#credentials = settings.credentials
        for (const { connection } of this.#all) {
            Object.assign(connection.options, this.#tlsOption(), this.#credentials ?? {})
            connection.disconnect(true)
        }
        this.#log.info(`Conexões com Redis refeitas com credenciais/certificados novos${describeTls(settings.tls)}`)
    }

    /** Falha rápido se o Redis cair, para não segurar a requisição HTTP. */
    public forQueue(name = 'queue'): Redis {
        return this.#track(name, new Redis(this.#url, { connectionName: name, ...this.#tlsOption(), ...this.#credentials }))
    }

    /** O Worker do BullMQ exige maxRetriesPerRequest: null. */
    public forWorker(name = 'worker'): Redis {
        return this.#track(name, new Redis(this.#url, {
            connectionName: name,
            maxRetriesPerRequest: null,
            ...this.#tlsOption(),
            ...this.#credentials,
        }))
    }

    /** Espera todas as conexões ficarem prontas (as tentativas aparecem nos logs). */
    public async ready(): Promise<void> {
        this.#log.info(`Conectando ao Redis em ${redactUri(this.#url)}${describeTls(this.#tlsConfig)}...`)
        await Promise.all(this.#all.map(item => item.ready))
    }

    /** Estado de cada conexão ("ready" quando pronta), para o /health/ready. */
    public status(): Record<string, string> {
        return Object.fromEntries(this.#all.map(item => [item.name, item.connection.status]))
    }

    public async close(): Promise<void> {
        this.#closing = true
        await Promise.allSettled(this.#all.map(item => item.connection.quit()))
        this.#log.info('Conexões com Redis encerradas')
    }

    /** Com rediss:// o ioredis já liga o TLS; a opção acrescenta CA, certificado de cliente e SNI. */
    #tlsOption(): { tls?: TlsClientOptions } {
        return this.#tls ? { tls: this.#tls } : {}
    }

    #track(name: string, connection: Redis): Redis {
        let connectedBefore = false
        let lost = false
        let lastError = ''
        const ready = new Promise<void>(resolve => connection.once('ready', () => resolve()))

        connection.on('ready', () => {
            if (!connectedBefore) this.#log.info(`Conexão com Redis (${name}) estabelecida`)
            else this.#log.info(`Conexão com Redis (${name}) restabelecida`)
            connectedBefore = true
            lost = false
            lastError = ''
        })
        connection.on('close', () => {
            if (this.#closing || lost || !connectedBefore) return
            lost = true
            this.#log.warn(`Conexão com Redis (${name}) perdida`)
        })
        connection.on('reconnecting', (delay: number) => {
            if (this.#closing) return
            const verb = connectedBefore ? 'reconectar' : 'conectar'
            const reason = lastError ? ` (último erro: ${lastError})` : ''
            this.#log.warn(`Tentando ${verb} ao Redis (${name}) em ${delay}ms${reason}`)
        })
        // durante a queda o mesmo erro se repete a cada tentativa: guarda para o log de "reconnecting"
        connection.on('error', (err: Error) => {
            if (err.message !== lastError) this.#log.error(`Erro na conexão com Redis (${name}): ${err.message}`)
            lastError = err.message
        })

        this.#all.push({ name, connection, ready })
        return connection
    }
}
