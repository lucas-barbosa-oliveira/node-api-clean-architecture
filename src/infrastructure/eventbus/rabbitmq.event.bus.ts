import { amqpClient, type IConnection, type IMessage } from 'amqp-client-node'
import { connect as amqpConnect } from 'amqplib'
import type { EventSubscription, IEventBus, IntegrationEvent, RpcResource } from '../../application/port/event.bus.ts'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import { formatMs, redactUri, retryUntilConnected } from '../resilience/retry.ts'
import { topicMatches } from './topic.ts'

/** Uma conexão por papel, como nos outros serviços: publicar não disputa canal com consumir ou responder RPC. */
const ROLES = {
    publish: 'publish',
    subscribe: 'subscribe',
    rpcServer: 'RPC server',
    rpcClient: 'RPC client',
} as const
type Role = keyof typeof ROLES

const TOPIC_EXCHANGE = { type: 'topic', durable: true }
const RPC_EXCHANGE = { type: 'direct', durable: true }
const PUBLISH_TIMEOUT_MS = 10_000

type Buffered = { exchange: string; routingKey: string; event: IntegrationEvent }

export type RabbitMqEventBusOptions = {
    /** amqp://usuario:senha@host:5672/vhost */
    uri: string;
    /** Nome deste serviço: fila dos subscribers (<service>) e exchange/fila do servidor RPC (<service>.rpc). */
    service: string;
    logger?: ILogger;
    /** Intervalo entre tentativas de (re)conexão. */
    retryIntervalMs?: number;
    rpcTimeoutMs?: number;
    /** Eventos guardados enquanto o barramento está fora do ar; acima disso, os mais antigos são descartados. */
    bufferSize?: number;
}

/**
 * Barramento RabbitMQ com a biblioteca amqp-client-node (publish/subscribe em exchanges topic e RPC em exchange direct).
 *
 * Conexão:
 *  - na inicialização, cada tentativa é feita com o amqplib (para o log trazer o motivo real da falha:
 *    recusa de conexão, credenciais, vhost); quando responde, as conexões da biblioteca são abertas;
 *  - depois, a própria biblioteca reconecta para sempre (retries: 0) e refaz exchanges, filas e consumidores;
 *    os eventos disconnected/trying/reestablished de cada conexão viram logs.
 */
export class RabbitMqEventBus implements IEventBus {
    #options: Required<Omit<RabbitMqEventBusOptions, 'logger'>>
    #log: ILogger
    #connections: Partial<Record<Role, IConnection>> = {}
    #up: Partial<Record<Role, boolean>> = {}
    #subscriptions: EventSubscription[] = []
    #appliedSubscriptions = new Set<EventSubscription>()
    #resources = new Map<string, RpcResource>()
    #rpcServer?: ReturnType<IConnection['createRpcServer']>
    #buffer: Buffered[] = []
    #dropped = 0
    #flushing = false
    #closing = false
    #abort = new AbortController()
    #started = false
    #handled = new WeakSet<IMessage>()

    constructor(options: RabbitMqEventBusOptions) {
        this.#log = options.logger ?? silentLogger
        this.#options = {
            uri: options.uri,
            service: options.service,
            retryIntervalMs: options.retryIntervalMs ?? 2000,
            rpcTimeoutMs: options.rpcTimeoutMs ?? 5000,
            bufferSize: options.bufferSize ?? 1000,
        }
    }

    public get isConnected(): boolean {
        return Boolean(this.#up.publish)
    }

    public start(): void {
        if (this.#started) return
        this.#started = true
        this.#connect().catch(err => {
            if (!this.#closing) this.#log.error('Falha ao configurar o barramento', { err })
        })
    }

    public async publish(exchange: string, routingKey: string, event: IntegrationEvent): Promise<void> {
        if (!this.#up.publish || this.#flushing) {
            this.#enqueue({ exchange, routingKey, event })
            return
        }
        try {
            await this.#send({ exchange, routingKey, event })
        } catch (err) {
            this.#log.warn(`Falha ao publicar ${event.event_name}: ${(err as Error).message}. Evento mantido no buffer`)
            this.#enqueue({ exchange, routingKey, event })
        }
    }

    public subscribe(subscription: EventSubscription): void {
        this.#subscriptions.push(subscription)
        if (this.#up.subscribe) void this.#applySubscription(subscription)
    }

    public provideResource(resource: RpcResource): void {
        this.#resources.set(resource.name, resource)
        if (this.#rpcServer) void this.#registerResource(resource).then(() => this.#rpcServer?.start())
    }

    public async executeResource(service: string, resource: string, ...params: unknown[]): Promise<unknown> {
        const connection = this.#connections.rpcClient
        if (!connection || !this.#up.rpcClient) {
            throw new Error('Barramento indisponível: não foi possível chamar o recurso RPC')
        }
        this.#log.debug(`Chamando recurso RPC ${service}/${resource}`)
        return connection.rpcClient(`${service}.rpc`, resource, params, {
            exchange: RPC_EXCHANGE,
            rpcTimeout: this.#options.rpcTimeoutMs,
        })
    }

    public async close(): Promise<void> {
        this.#closing = true
        this.#abort.abort(new Error('barramento encerrado'))
        if (this.#up.publish && this.#buffer.length > 0) await this.#flush()
        if (this.#buffer.length > 0) {
            this.#log.warn(`${this.#buffer.length} evento(s) do buffer não enviados: barramento indisponível no encerramento`)
        }
        await Promise.allSettled(Object.values(this.#connections).map(connection => connection.close()))
        if (Object.keys(this.#connections).length > 0) this.#log.info('Conexões com RabbitMQ encerradas')
    }

    async #connect(): Promise<void> {
        const { uri, retryIntervalMs } = this.#options
        this.#log.info(`Conectando ao RabbitMQ em ${redactUri(uri)}...`)
        await retryUntilConnected(async () => {
            const probe = await amqpConnect(uri, { timeout: 5000 })
            await probe.close()
        }, {
            name: 'RabbitMQ',
            logger: this.#log,
            initialDelayMs: retryIntervalMs,
            maxDelayMs: 15_000,
            signal: this.#abort.signal,
        })

        await Promise.all((Object.keys(ROLES) as Role[]).map(role => this.#open(role)))
        if (this.#closing) return

        await this.#startRpcServer()
        await Promise.all(this.#subscriptions.map(subscription => this.#applySubscription(subscription)))
        if (this.#subscriptions.length === 0) this.#log.info('Nenhum subscriber configurado')
        if (this.#buffer.length > 0) await this.#flush()
    }

    async #open(role: Role): Promise<void> {
        const connection = await amqpClient.createConnection(this.#options.uri, {
            retries: 0, // a biblioteca tenta reconectar para sempre
            interval: this.#options.retryIntervalMs,
        })
        this.#connections[role] = connection
        this.#up[role] = true
        this.#log.info(`Conexão RabbitMQ (${ROLES[role]}) estabelecida`)

        let attempts = 0
        connection.on('disconnected', () => {
            if (this.#closing) return
            this.#up[role] = false
            attempts = 0
            this.#log.warn(`Conexão RabbitMQ (${ROLES[role]}) perdida. Tentando reconectar...`)
        })
        connection.on('trying', () => {
            if (this.#closing) return
            attempts++
            const interval = formatMs(this.#options.retryIntervalMs)
            this.#log.warn(`Tentativa ${attempts} de reconexão RabbitMQ (${ROLES[role]}) falhou. Nova tentativa em ${interval}`)
        })
        connection.on('reestablished', () => {
            this.#up[role] = true
            this.#log.info(`Conexão RabbitMQ (${ROLES[role]}) restabelecida`)
            if (role === 'publish' && this.#buffer.length > 0) void this.#flush()
        })
    }

    async #send(item: Buffered): Promise<void> {
        const connection = this.#connections.publish
        if (!connection) throw new Error('sem conexão de publicação')
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<never>((_resolve, reject) => {
            const message = `sem confirmação em ${formatMs(PUBLISH_TIMEOUT_MS)}`
            timer = setTimeout(() => reject(new Error(message)), PUBLISH_TIMEOUT_MS)
        })
        try {
            await Promise.race([
                connection.pub(item.exchange, item.routingKey, { content: item.event }, { exchange: TOPIC_EXCHANGE }),
                timeout,
            ])
        } finally {
            clearTimeout(timer)
        }
        this.#log.info(`Evento ${item.event.event_name} publicado em ${item.exchange} (${item.routingKey})`)
    }

    #enqueue(item: Buffered): void {
        if (this.#buffer.length === 0 && !this.#flushing) {
            const max = this.#options.bufferSize
            this.#log.warn(`Barramento indisponível: eventos ficam em buffer (até ${max}) até a conexão voltar`)
        }
        this.#buffer.push(item)
        if (this.#buffer.length > this.#options.bufferSize) {
            this.#buffer.shift()
            this.#dropped++
            if (this.#dropped === 1 || this.#dropped % 100 === 0) {
                this.#log.error(`Buffer do barramento cheio: ${this.#dropped} evento(s) mais antigo(s) descartado(s)`)
            }
        }
    }

    /** Envia o buffer em ordem. Se a conexão cair no meio, o que sobrou continua no buffer. */
    async #flush(): Promise<void> {
        if (this.#flushing) return
        this.#flushing = true
        let sent = 0
        try {
            while (this.#buffer.length > 0 && this.#up.publish) {
                await this.#send(this.#buffer[0])
                this.#buffer.shift()
                sent++
            }
        } catch (err) {
            this.#log.warn(`Envio do buffer interrompido: ${(err as Error).message}`)
        } finally {
            this.#flushing = false
        }
        if (sent > 0) this.#log.info(`${sent} evento(s) do buffer enviado(s); ${this.#buffer.length} pendente(s)`)
        if (this.#dropped > 0) {
            this.#log.warn(`${this.#dropped} evento(s) foram descartados enquanto o barramento esteve fora do ar`)
            this.#dropped = 0
        }
    }

    async #applySubscription(subscription: EventSubscription): Promise<void> {
        const connection = this.#connections.subscribe
        if (!connection || this.#appliedSubscriptions.has(subscription)) return
        this.#appliedSubscriptions.add(subscription)
        try {
            await connection.sub(this.#options.service, subscription.exchange, subscription.routingKey, this.#dispatch, {
                exchange: TOPIC_EXCHANGE,
                queue: { durable: true },
                consumer: { noAck: false },
                receiveFromYourself: false,
            })
            this.#log.info(
                `Subscriber ${subscription.eventName} configurado (exchange "${subscription.exchange}", `
                + `routing key "${subscription.routingKey}", fila "${this.#options.service}")`,
            )
        } catch (err) {
            this.#appliedSubscriptions.delete(subscription)
            this.#log.error(`Falha ao configurar o subscriber ${subscription.eventName}`, { err })
        }
    }

    /**
     * Todas as assinaturas compartilham a fila do serviço. A biblioteca chama o callback de cada routing key
     * que "parece" casar (a comparação dela é aproximada), às vezes mais de uma vez para a mesma mensagem.
     * Por isso cada mensagem é processada uma única vez aqui, com a comparação exata de exchange e tópico.
     */
    #dispatch = (message: IMessage): void => {
        if (this.#handled.has(message)) return
        this.#handled.add(message)
        void this.#process(message)
    }

    async #process(message: IMessage): Promise<void> {
        const exchange = message.fields?.exchange ?? ''
        const routingKey = message.fields?.routingKey ?? ''
        const event = message.content as IntegrationEvent | undefined
        const targets = this.#subscriptions.filter(sub =>
            sub.exchange === exchange
            && topicMatches(sub.routingKey, routingKey)
            && (!event?.event_name || sub.eventName === event.event_name))

        if (targets.length === 0) {
            this.#log.warn(`Mensagem sem subscriber (exchange "${exchange}", routing key "${routingKey}"): descartada`)
            message.ack()
            return
        }
        this.#log.info(`Evento ${event?.event_name ?? '(sem nome)'} recebido de ${exchange} (${routingKey})`)
        try {
            for (const target of targets) await target.handle(event as IntegrationEvent)
            message.ack()
        } catch (err) {
            // sem requeue: um evento que sempre falha não pode travar a fila (configure uma dead-letter exchange se precisar)
            this.#log.error(`Subscriber ${event?.event_name} falhou; mensagem descartada`, { err })
            message.nack(false, false)
        }
    }

    async #startRpcServer(): Promise<void> {
        const connection = this.#connections.rpcServer
        if (!connection) return
        const name = `${this.#options.service}.rpc`
        this.#rpcServer = connection.createRpcServer(name, name, [], {
            exchange: RPC_EXCHANGE,
            queue: { durable: false, expires: 5000 }, // a fila some se o serviço ficar fora do ar (pedidos expirariam mesmo)
        })
        for (const resource of this.#resources.values()) await this.#registerResource(resource)
        if (this.#resources.size === 0) {
            this.#log.info('Nenhum recurso RPC para oferecer')
            return
        }
        await this.#rpcServer.start()
        this.#log.info(`Servidor RPC pronto (exchange "${name}", ${this.#resources.size} recurso(s))`)
    }

    async #registerResource(resource: RpcResource): Promise<void> {
        // a biblioteca descarta Promises rejeitadas (o cliente só veria timeout): o erro volta como resposta de erro
        this.#rpcServer?.addResource(resource.name, async (...params: unknown[]) => {
            this.#log.debug(`Recurso RPC ${resource.name} chamado`)
            try {
                return await resource.handle(...params)
            } catch (err) {
                this.#log.warn(`Recurso RPC ${resource.name} falhou: ${(err as Error).message}`)
                return err instanceof Error ? err : new Error(String(err))
            }
        })
        this.#log.info(`Recurso RPC ${resource.name} registrado`)
    }
}
