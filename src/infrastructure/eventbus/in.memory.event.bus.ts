import type { EventSubscription, IEventBus, IntegrationEvent, RpcResource } from '../../application/port/event.bus.ts'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import { topicMatches } from './topic.ts'

/**
 * Barramento dentro do processo (EVENT_BUS_DRIVER=memory): publish/subscribe e RPC sem RabbitMQ.
 * Serve para desenvolvimento e testes; nada sai do processo, então outros serviços não recebem os eventos.
 */
export class InMemoryEventBus implements IEventBus {
    #log: ILogger
    #service: string
    #subscriptions: EventSubscription[] = []
    #resources = new Map<string, RpcResource>()
    #pending = new Set<Promise<void>>()
    #started = false

    constructor(options: { service: string; logger?: ILogger }) {
        this.#service = options.service
        this.#log = options.logger ?? silentLogger
    }

    public get isConnected(): boolean {
        return this.#started
    }

    public start(): void {
        this.#started = true
        this.#log.info('Barramento em memória (EVENT_BUS_DRIVER=memory): eventos não saem deste processo')
    }

    public async publish(exchange: string, routingKey: string, event: IntegrationEvent): Promise<void> {
        this.#log.info(`Evento ${event.event_name} publicado em ${exchange} (${routingKey})`)
        for (const sub of this.#subscriptions) {
            if (sub.exchange !== exchange || !topicMatches(sub.routingKey, routingKey)) continue
            // entrega assíncrona, como em um broker: quem publica não espera o assinante
            const delivery = sub.handle(structuredClone(event)).catch(err => {
                this.#log.error(`Subscriber ${sub.eventName} falhou ao processar o evento`, { err })
            })
            this.#pending.add(delivery)
            void delivery.finally(() => this.#pending.delete(delivery))
        }
    }

    public subscribe(subscription: EventSubscription): void {
        this.#subscriptions.push(subscription)
        const { eventName, exchange, routingKey } = subscription
        this.#log.info(`Subscriber ${eventName} configurado (exchange "${exchange}", routing key "${routingKey}")`)
    }

    public provideResource(resource: RpcResource): void {
        this.#resources.set(resource.name, resource)
        this.#log.info(`Recurso RPC ${resource.name} registrado`)
    }

    public async executeResource(service: string, resource: string, ...params: unknown[]): Promise<unknown> {
        const target = service === this.#service ? this.#resources.get(resource) : undefined
        if (!target) throw new Error(`Recurso ${service}/${resource} indisponível no barramento em memória`)
        return structuredClone(await target.handle(...structuredClone(params)))
    }

    /** Espera os assinantes terminarem (útil em testes). */
    public async drain(): Promise<void> {
        while (this.#pending.size > 0) await Promise.allSettled([...this.#pending])
    }

    public async close(): Promise<void> {
        await this.drain()
        this.#started = false
    }
}
