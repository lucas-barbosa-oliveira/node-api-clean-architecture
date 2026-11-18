import { randomUUID } from 'node:crypto'
import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Message } from 'amqplib'
import type {
    EventSubscription,
    IEventBus,
    IntegrationEvent,
    PublishOptions,
    RpcResource,
} from '../../application/port/event.bus.ts'
import { EventBusUnavailableError } from '../../application/port/event.bus.ts'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import { redactUri, sleep } from '../resilience/retry.ts'
import { describeTls, readTlsClientOptions, type TlsClientConfig } from '../security/tls.ts'
import { ManagedConnection } from './managed.connection.ts'
import { appMetrics } from '../telemetry/metrics.ts'
import { topicMatches } from './topic.ts'

const DURABLE_EXCHANGE = { durable: true } as const
/** Mesmos argumentos da amqp-client-node: declarar a mesma fila com outros argumentos daria PRECONDITION_FAILED. */
const RPC_QUEUE = { durable: false, expires: 5000 } as const
const SERVICE_QUEUE = { durable: true } as const
const DIRECT_REPLY_TO = 'amq.rabbitmq.reply-to'
const PUBLISH_TIMEOUT_MS = 10_000

export type RabbitMqEventBusOptions = {
    /** amqp://usuario:senha@host:5672/vhost */
    uri: string;
    /** Nome deste serviço: fila dos subscribers (<service>) e exchange/fila do servidor RPC (<service>.rpc). */
    service: string;
    logger?: ILogger;
    retryIntervalMs?: number;
    rpcTimeoutMs?: number;
    /** Mensagens entregues e ainda não confirmadas por consumidor (controle de vazão). */
    prefetch?: number;
    /** TLS das conexões (exige amqps:// na uri). */
    tls?: TlsClientConfig;
    /** Substituem os da uri (ex.: usuário dinâmico do Vault). */
    credentials?: RabbitMqCredentials;
    /** Tentativas de um subscriber antes de a mensagem ir para a fila <service>.dlq. */
    subscriberAttempts?: number;
}

export type RabbitMqCredentials = { username?: string; password?: string }

/** Põe usuário e senha na URI (codificados): amqplib só aceita credenciais nela. */
export function withCredentials(uri: string, credentials?: RabbitMqCredentials): string {
    if (!credentials?.username && !credentials?.password) return uri
    const url = new URL(uri)
    if (credentials.username) url.username = encodeURIComponent(credentials.username)
    if (credentials.password) url.password = encodeURIComponent(credentials.password)
    return url.toString()
}

type PendingCall = {
    timer: NodeJS.Timeout;
    label: string;
    resolve(value: unknown): void;
    reject(err: Error): void;
}

/**
 * Barramento RabbitMQ com o amqplib (publish/subscribe em exchanges topic e RPC em exchange direct).
 *
 * Compatível com os serviços que usam a amqp-client-node: mesmo formato de mensagem (JSON), mesma convenção de RPC
 * ({ resource_name, handle }, resposta por direct reply-to e type "error" nas falhas) e mesmos argumentos de filas.
 *
 * Duas conexões (recomendação do RabbitMQ: quem publica não divide conexão com quem consome):
 *  - publish: canal com confirmação do broker (publish só resolve quando o RabbitMQ aceitou) e canal de RPC client;
 *  - consume: canal dos subscribers (fila <service>) e canal do servidor RPC (fila <service>.rpc).
 */
export class RabbitMqEventBus implements IEventBus {
    #options: Required<Omit<RabbitMqEventBusOptions, 'logger' | 'tls' | 'credentials'>>
    #tls?: TlsClientConfig
    #log: ILogger
    #instanceId = randomUUID()
    #publisher: ManagedConnection
    #consumer: ManagedConnection
    #confirmChannel?: ConfirmChannel
    #rpcClientChannel?: Channel
    #subscriptionChannel?: Channel
    #rpcServerChannel?: Channel
    #declaredExchanges = new Set<string>()
    #subscriptions: EventSubscription[] = []
    #resources = new Map<string, RpcResource>()
    #pendingCalls = new Map<string, PendingCall>()
    #started = false

    constructor(options: RabbitMqEventBusOptions) {
        this.#log = options.logger ?? silentLogger
        this.#options = {
            uri: options.uri,
            service: options.service,
            retryIntervalMs: options.retryIntervalMs ?? 2000,
            rpcTimeoutMs: options.rpcTimeoutMs ?? 5000,
            prefetch: options.prefetch ?? 20,
            subscriberAttempts: options.subscriberAttempts ?? 3,
        }
        this.#tls = options.tls
        const common = {
            service: this.#options.service,
            uri: withCredentials(this.#options.uri, options.credentials),
            logger: this.#log,
            retryIntervalMs: this.#options.retryIntervalMs,
            tls: options.tls && readTlsClientOptions(options.tls),
        }
        this.#publisher = new ManagedConnection({
            ...common,
            name: 'publish',
            setup: connection => this.#setupPublisher(connection),
            onLost: () => this.#rejectPendingCalls('conexão com o RabbitMQ perdida'),
        })
        this.#consumer = new ManagedConnection({
            ...common,
            name: 'consume',
            setup: connection => this.#setupConsumer(connection),
        })
    }

    public get isConnected(): boolean {
        return this.#publisher.isUp && Boolean(this.#confirmChannel)
    }

    public status(): Record<string, boolean> {
        return { publish: this.#publisher.isUp, consume: this.#consumer.isUp }
    }

    /** Credenciais ou certificados renovados: as duas conexões são refeitas com os valores novos. */
    public async reconfigure(settings: { tls?: TlsClientConfig; credentials?: RabbitMqCredentials }): Promise<void> {
        const next = {
            uri: withCredentials(this.#options.uri, settings.credentials),
            tls: settings.tls && readTlsClientOptions(settings.tls),
        }
        this.#tls = settings.tls
        await this.#publisher.reconfigure(next)
        await this.#consumer.reconfigure(next)
    }

    public start(): void {
        if (this.#started) return
        this.#started = true
        this.#log.info(`Conectando ao RabbitMQ em ${redactUri(this.#options.uri)}${describeTls(this.#tls)}...`)
        this.#publisher.start()
        this.#consumer.start()
    }

    public async publish(
        exchange: string,
        routingKey: string,
        event: IntegrationEvent,
        options: PublishOptions = {},
    ): Promise<void> {
        const channel = this.#confirmChannel
        if (!channel || !this.#publisher.isUp) throw new EventBusUnavailableError()
        await this.#declareTopic(channel, exchange)
        await new Promise<void>((resolve, reject) => {
            const timeout = new Error(`sem confirmação do RabbitMQ em ${PUBLISH_TIMEOUT_MS} ms`)
            const timer = setTimeout(() => reject(timeout), PUBLISH_TIMEOUT_MS)
            channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(event)), {
                contentType: 'application/json',
                persistent: true, // sobrevive a um reinício do RabbitMQ (em fila durável)
                messageId: options.messageId,
                timestamp: Math.floor(Date.now() / 1000),
                appId: this.#options.service,
                correlationId: this.#instanceId, // a amqp-client-node usa para ignorar as próprias mensagens
                type: event.event_name,
            }, err => {
                clearTimeout(timer)
                if (err) reject(err instanceof Error ? err : new Error('mensagem recusada pelo RabbitMQ (nack)'))
                else resolve()
            })
        })
        this.#log.info(`Evento ${event.event_name} publicado em ${exchange} (${routingKey})`)
    }

    public subscribe(subscription: EventSubscription): void {
        this.#subscriptions.push(subscription)
        const channel = this.#subscriptionChannel
        if (channel) {
            void this.#bind(channel, subscription)
                .catch(err => this.#log.error(`Falha ao configurar ${subscription.eventName}`, { err }))
        }
    }

    public provideResource(resource: RpcResource): void {
        this.#resources.set(resource.name, resource)
        const channel = this.#rpcServerChannel
        if (channel) {
            void channel.bindQueue(this.#rpcName, this.#rpcName, resource.name)
                .then(() => this.#log.info(`Recurso RPC ${resource.name} registrado`))
                .catch(err => this.#log.error(`Falha ao registrar o recurso RPC ${resource.name}`, { err }))
        }
    }

    public async executeResource(service: string, resource: string, ...params: unknown[]): Promise<unknown> {
        const channel = this.#rpcClientChannel
        if (!channel || !this.#publisher.isUp) {
            throw new EventBusUnavailableError('Barramento indisponível: não foi possível chamar o recurso RPC')
        }
        const exchange = `${service}.rpc`
        if (!this.#declaredExchanges.has(exchange)) {
            await channel.assertExchange(exchange, 'direct', DURABLE_EXCHANGE)
            this.#declaredExchanges.add(exchange)
        }
        const correlationId = randomUUID()
        const label = `${service}/${resource}`
        const timeoutMs = this.#options.rpcTimeoutMs
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pendingCalls.delete(correlationId)
                reject(new Error(`RPC ${label}: sem resposta em ${timeoutMs} ms`))
            }, timeoutMs)
            this.#pendingCalls.set(correlationId, { resolve, reject, timer, label })
            this.#log.debug(`Chamando recurso RPC ${label}`)
            channel.publish(exchange, resource, Buffer.from(JSON.stringify({ resource_name: resource, handle: params })), {
                contentType: 'application/json',
                correlationId,
                replyTo: DIRECT_REPLY_TO,
                // sem fila ligada a esse recurso, o broker devolve a mensagem (evento "return") em vez de descartar
                mandatory: true,
                expiration: String(timeoutMs), // pedido não atendido a tempo não fica na fila
            })
        })
    }

    public async close(): Promise<void> {
        this.#rejectPendingCalls('barramento encerrado')
        await Promise.all([this.#publisher.close(), this.#consumer.close()])
        if (this.#started) this.#log.info('Conexões com RabbitMQ encerradas')
    }

    get #rpcName(): string {
        return `${this.#options.service}.rpc`
    }

    async #setupPublisher(connection: ChannelModel): Promise<void> {
        this.#declaredExchanges.clear()
        this.#confirmChannel = undefined
        this.#rpcClientChannel = undefined

        const confirm = await connection.createConfirmChannel()
        confirm.on('error', (err: Error) => this.#log.error(`Erro no canal de publicação: ${err.message}`))
        confirm.on('close', () => {
            if (this.#confirmChannel === confirm) this.#confirmChannel = undefined
        })

        const rpc = await connection.createChannel()
        rpc.on('error', (err: Error) => this.#log.error(`Erro no canal de RPC client: ${err.message}`))
        rpc.on('return', (message: Message) => this.#settle(
            message.properties.correlationId,
            new Error(`Recurso RPC indisponível: ninguém oferece "${message.fields.routingKey}" em ${message.fields.exchange}`),
        ))
        // direct reply-to: a resposta chega no mesmo canal que publicou o pedido, sem fila temporária
        await rpc.consume(DIRECT_REPLY_TO, message => {
            if (message) this.#onRpcReply(message)
        }, { noAck: true })

        this.#confirmChannel = confirm
        this.#rpcClientChannel = rpc
    }

    async #setupConsumer(connection: ChannelModel): Promise<void> {
        this.#subscriptionChannel = undefined
        this.#rpcServerChannel = undefined
        const { service, prefetch } = this.#options

        const subscriptions = await connection.createChannel()
        subscriptions.on('error', (err: Error) => this.#log.error(`Erro no canal de subscribers: ${err.message}`))
        await subscriptions.prefetch(prefetch)
        await subscriptions.assertQueue(service, SERVICE_QUEUE)
        // fila separada, sem argumentos especiais: não muda a fila do serviço (compatível com filas já existentes)
        await subscriptions.assertQueue(this.#dlqName, SERVICE_QUEUE)
        for (const subscription of this.#subscriptions) await this.#bind(subscriptions, subscription)
        await subscriptions.consume(service, message => {
            if (message) void this.#onEvent(subscriptions, message)
        }, { noAck: false })
        if (this.#subscriptions.length === 0) this.#log.info('Nenhum subscriber configurado')

        const rpc = await connection.createChannel()
        rpc.on('error', (err: Error) => this.#log.error(`Erro no canal do servidor RPC: ${err.message}`))
        await rpc.prefetch(prefetch)
        await rpc.assertExchange(this.#rpcName, 'direct', DURABLE_EXCHANGE)
        await rpc.assertQueue(this.#rpcName, RPC_QUEUE)
        for (const name of this.#resources.keys()) {
            await rpc.bindQueue(this.#rpcName, this.#rpcName, name)
            this.#log.info(`Recurso RPC ${name} registrado`)
        }
        await rpc.consume(this.#rpcName, message => {
            if (message) void this.#onRpcRequest(rpc, message)
        }, { noAck: false })
        if (this.#resources.size > 0) {
            this.#log.info(`Servidor RPC pronto (exchange "${this.#rpcName}", ${this.#resources.size} recurso(s))`)
        }

        this.#subscriptionChannel = subscriptions
        this.#rpcServerChannel = rpc
    }

    async #declareTopic(channel: Channel, exchange: string): Promise<void> {
        if (this.#declaredExchanges.has(exchange)) return
        await channel.assertExchange(exchange, 'topic', DURABLE_EXCHANGE)
        this.#declaredExchanges.add(exchange)
    }

    async #bind(channel: Channel, subscription: EventSubscription): Promise<void> {
        await channel.assertExchange(subscription.exchange, 'topic', DURABLE_EXCHANGE)
        await channel.bindQueue(this.#options.service, subscription.exchange, subscription.routingKey)
        this.#log.info(
            `Subscriber ${subscription.eventName} configurado (exchange "${subscription.exchange}", `
            + `routing key "${subscription.routingKey}", fila "${this.#options.service}")`,
        )
    }

    /** Cada mensagem vai para os subscribers da exchange e routing key (e do event_name, se houver) e é confirmada uma vez. */
    async #onEvent(channel: Channel, message: ConsumeMessage): Promise<void> {
        const { exchange, routingKey } = message.fields
        let event: IntegrationEvent
        try {
            event = JSON.parse(message.content.toString()) as IntegrationEvent
        } catch {
            this.#log.warn(`Mensagem de ${exchange} (${routingKey}) não é JSON: enviada para ${this.#dlqName}`)
            this.#deadLetter(channel, message, { reason: 'invalid_json', attempts: 0 })
            return
        }
        const targets = this.#subscriptions.filter(sub =>
            sub.exchange === exchange
            && topicMatches(sub.routingKey, routingKey)
            && (!event.event_name || sub.eventName === event.event_name))
        if (targets.length === 0) {
            this.#log.warn(`Mensagem sem subscriber (exchange "${exchange}", routing key "${routingKey}"): descartada`)
            channel.ack(message)
            return
        }
        this.#log.info(`Evento ${event.event_name ?? '(sem nome)'} recebido de ${exchange} (${routingKey})`)
        const { subscriberAttempts } = this.#options
        for (let attempt = 1; attempt <= subscriberAttempts; attempt++) {
            try {
                // numa nova tentativa, todos os subscribers rodam de novo: eles precisam ser idempotentes
                for (const target of targets) await target.handle(event)
                channel.ack(message)
                return
            } catch (err) {
                if (attempt < subscriberAttempts) {
                    this.#log.warn(`Subscriber ${event.event_name} falhou (tentativa ${attempt}/${subscriberAttempts}): `
                        + `${(err as Error).message}`)
                    await sleep(200 * 2 ** (attempt - 1))
                    continue
                }
                // sem requeue: um evento que sempre falha não pode travar a fila; fica guardado para análise
                const failure = `Subscriber ${event.event_name} falhou ${attempt} vez(es): enviado para ${this.#dlqName}`
                this.#log.error(failure, { err })
                this.#deadLetter(channel, message, {
                    reason: (err as Error).message ?? String(err),
                    attempts: attempt,
                    eventName: event.event_name,
                })
            }
        }
    }

    get #dlqName(): string {
        return `${this.#options.service}.dlq`
    }

    /**
     * Copia a mensagem para <service>.dlq com o motivo e a origem nos headers e confirma a original.
     * Para reprocessar: mover as mensagens de volta pela interface do RabbitMQ (Shovel) ou republicar.
     */
    #deadLetter(
        channel: Channel,
        message: ConsumeMessage,
        info: { reason: string; attempts: number; eventName?: string },
    ): void {
        const { exchange, routingKey } = message.fields
        channel.sendToQueue(this.#dlqName, message.content, {
            ...message.properties,
            persistent: true,
            headers: {
                ...message.properties.headers,
                'x-dlq-reason': info.reason.slice(0, 500),
                'x-dlq-attempts': info.attempts,
                'x-dlq-exchange': exchange,
                'x-dlq-routing-key': routingKey,
                'x-dlq-failed-at': new Date().toISOString(),
                'x-dlq-service': this.#options.service,
            },
        })
        channel.ack(message)
        appMetrics.deadLettered.add(1, {
            event_name: info.eventName ?? 'unknown',
            reason: info.reason === 'invalid_json' ? 'invalid_json' : 'handler_failed',
        })
    }

    async #onRpcRequest(channel: Channel, message: ConsumeMessage): Promise<void> {
        const { replyTo, correlationId } = message.properties as { replyTo?: string; correlationId?: string }
        let reply: { content: Buffer; contentType: string; type?: string }
        try {
            const request = JSON.parse(message.content.toString()) as { resource_name?: string; handle?: unknown[] }
            const resource = this.#resources.get(request.resource_name ?? message.fields.routingKey)
            if (!resource) throw new Error('Resource not registered in server')
            this.#log.debug(`Recurso RPC ${resource.name} chamado`)
            const result = await resource.handle(...(Array.isArray(request.handle) ? request.handle : []))
            reply = typeof result === 'string'
                ? { content: Buffer.from(result), contentType: 'text/plain' }
                : { content: Buffer.from(JSON.stringify(result ?? null)), contentType: 'application/json' }
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            this.#log.warn(`Recurso RPC ${message.fields.routingKey} falhou: ${error.message}`)
            // mesmo formato da amqp-client-node: texto do erro com type "error"
            reply = { content: Buffer.from(error.toString()), contentType: 'text/plain', type: 'error' }
        }
        if (replyTo) {
            channel.sendToQueue(replyTo, reply.content, { correlationId, contentType: reply.contentType, type: reply.type })
        }
        channel.ack(message)
    }

    #onRpcReply(message: ConsumeMessage): void {
        type ReplyProperties = { correlationId?: string; type?: string; contentType?: string }
        const { correlationId, type, contentType } = message.properties as ReplyProperties
        const text = message.content.toString()
        if (type === 'error') {
            // "ValidationError: Parâmetros inválidos" -> "Parâmetros inválidos"
            this.#settle(correlationId, new Error(text.replace(/^\w*Error: /, '')))
            return
        }
        let value: unknown = text
        if (contentType === 'application/json') {
            try {
                value = JSON.parse(text)
            } catch {
                value = text
            }
        }
        this.#settle(correlationId, undefined, value)
    }

    #settle(correlationId: string | undefined, error?: Error, value?: unknown): void {
        const call = correlationId ? this.#pendingCalls.get(correlationId) : undefined
        if (!call || !correlationId) return
        this.#pendingCalls.delete(correlationId)
        clearTimeout(call.timer)
        if (error) call.reject(error)
        else call.resolve(value)
    }

    #rejectPendingCalls(reason: string): void {
        for (const [id, call] of this.#pendingCalls) {
            clearTimeout(call.timer)
            call.reject(new Error(`RPC ${call.label}: ${reason}`))
            this.#pendingCalls.delete(id)
        }
    }
}
