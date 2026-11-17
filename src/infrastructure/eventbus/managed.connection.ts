import { connect, type ChannelModel } from 'amqplib'
import type { ILogger } from '../../application/port/logger.ts'
import { formatMs, sleep } from '../resilience/retry.ts'

export type ManagedConnectionOptions = {
    /** Papel da conexão nos logs e no RabbitMQ (aparece como connection_name na interface de administração). */
    name: string;
    service: string;
    uri: string;
    logger: ILogger;
    retryIntervalMs: number;
    maxRetryIntervalMs?: number;
    /** Declara canais, exchanges, filas e consumidores. Roda a cada (re)conexão; se falhar, a conexão é refeita. */
    setup(connection: ChannelModel): Promise<void>;
    /** Avisado quando a conexão cai (ex.: para rejeitar chamadas RPC pendentes). */
    onLost?(): void;
}

/**
 * Uma conexão AMQP que se refaz sozinha: na inicialização e a cada queda, tenta de novo para sempre (espera dobra até
 * maxRetryIntervalMs), registrando cada tentativa com o motivo real (recusa, credenciais, vhost, topologia incompatível).
 */
export class ManagedConnection {
    #options: Required<Omit<ManagedConnectionOptions, 'onLost'>> & Pick<ManagedConnectionOptions, 'onLost'>
    #connection?: ChannelModel
    #up = false
    #connectedBefore = false
    #closing = false
    #abort = new AbortController()
    #running = false

    constructor(options: ManagedConnectionOptions) {
        this.#options = { maxRetryIntervalMs: 15_000, ...options }
    }

    public get isUp(): boolean {
        return this.#up
    }

    public get connection(): ChannelModel | undefined {
        return this.#up ? this.#connection : undefined
    }

    public start(): void {
        if (this.#running) return
        this.#running = true
        void this.#connectLoop()
    }

    public async close(): Promise<void> {
        this.#closing = true
        this.#abort.abort(new Error('conexão encerrada'))
        this.#up = false
        await this.#connection?.close().catch(() => {})
    }

    async #connectLoop(): Promise<void> {
        const { name, uri, logger: log, retryIntervalMs, maxRetryIntervalMs, service } = this.#options
        let delay = retryIntervalMs
        for (let attempt = 1; !this.#closing; attempt++) {
            let connection: ChannelModel | undefined
            try {
                connection = await connect(uri, { timeout: 5000, clientProperties: { connection_name: `${service} (${name})` } })
                connection.on('error', (err: Error) => log.error(`Erro na conexão RabbitMQ (${name}): ${err.message}`))
                connection.once('close', (err?: Error) => this.#lost(connection as ChannelModel, err))
                await this.#options.setup(connection)
                this.#connection = connection
                this.#up = true
                const retries = attempt > 1 ? ` (após ${attempt - 1} tentativa(s) sem sucesso)` : ''
                log.info(`Conexão RabbitMQ (${name}) ${this.#connectedBefore ? 'restabelecida' : 'estabelecida'}${retries}`)
                this.#connectedBefore = true
                return
            } catch (err) {
                await connection?.close().catch(() => {})
                if (this.#closing) return
                const verb = this.#connectedBefore ? 'reconexão' : 'conexão'
                const next = formatMs(delay)
                log.warn(`Tentativa ${attempt} de ${verb} RabbitMQ (${name}) falhou: ${reason(err)}. Nova tentativa em ${next}`)
                try {
                    await sleep(delay, this.#abort.signal)
                } catch {
                    return
                }
                delay = Math.min(delay * 2, maxRetryIntervalMs)
            }
        }
    }

    #lost(connection: ChannelModel, err?: Error): void {
        // "close" de uma tentativa que já falhou no setup não conta como queda
        if (connection !== this.#connection || this.#closing) return
        this.#up = false
        this.#connection = undefined
        this.#options.onLost?.()
        const cause = err ? `: ${err.message}` : ''
        this.#options.logger.warn(`Conexão RabbitMQ (${this.#options.name}) perdida${cause}. Tentando reconectar...`)
        void this.#connectLoop()
    }
}

function reason(err: unknown): string {
    if (!(err instanceof Error)) return String(err)
    // erros de conexão do Node vêm agregados (IPv4 e IPv6): o primeiro já explica
    if (err instanceof AggregateError && err.errors[0] instanceof Error) return err.errors[0].message
    return err.message || (err as { code?: string }).code || err.name
}
