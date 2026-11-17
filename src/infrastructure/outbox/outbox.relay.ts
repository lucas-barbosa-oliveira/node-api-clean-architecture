import { context, metrics, propagation, ROOT_CONTEXT } from '@opentelemetry/api'
import { EventBusUnavailableError, type IEventBus } from '../../application/port/event.bus.ts'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import type { IOutboxStore } from './outbox.store.ts'

export type OutboxRelayOptions = {
    store: IOutboxStore;
    bus: IEventBus;
    logger?: ILogger;
    /** Intervalo de verificação quando não há aviso de evento novo (outra instância pode ter gravado). */
    pollIntervalMs?: number;
    batchSize?: number;
    /** Tempo de reserva de um lote: se a instância morrer no meio, outra assume depois disso. */
    lockMs?: number;
    /** Espera máxima entre tentativas de um evento que falhou (a espera dobra a cada falha). */
    maxBackoffMs?: number;
}

const meter = metrics.getMeter('outbox')
const publishedCounter = meter.createCounter('outbox.events.published', {
    description: 'Eventos do outbox publicados no barramento',
})
const failedCounter = meter.createCounter('outbox.events.failed', { description: 'Tentativas de publicação que falharam' })

/**
 * Publica no barramento os eventos gravados no outbox, em ordem de criação, com novas tentativas e espera crescente.
 * Nenhum evento é descartado: enquanto o RabbitMQ estiver fora do ar, eles esperam no banco.
 * Várias instâncias podem rodar o relay ao mesmo tempo (cada evento é reservado por uma só).
 * Entrega "pelo menos uma vez": se a instância cair entre publicar e marcar como enviado, o evento sai de novo
 * (com o mesmo messageId).
 */
export class OutboxRelay {
    #options: Required<Omit<OutboxRelayOptions, 'logger'>>
    #log: ILogger
    #running?: Promise<void>
    #stopped = false
    #wake?: () => void
    #waitingForBus = false
    #pendingGauge?: { pending: number; oldestAgeSeconds: number }

    constructor(options: OutboxRelayOptions) {
        this.#log = options.logger ?? silentLogger
        this.#options = {
            store: options.store,
            bus: options.bus,
            pollIntervalMs: options.pollIntervalMs ?? 1000,
            batchSize: options.batchSize ?? 100,
            lockMs: options.lockMs ?? 30_000,
            maxBackoffMs: options.maxBackoffMs ?? 5 * 60_000,
        }
        meter.createObservableGauge('outbox.events.pending', { description: 'Eventos aguardando publicação' })
            .addCallback(result => result.observe(this.#pendingGauge?.pending ?? 0))
        meter.createObservableGauge('outbox.oldest_pending.age', { description: 'Idade do pendente mais antigo', unit: 's' })
            .addCallback(result => result.observe(this.#pendingGauge?.oldestAgeSeconds ?? 0))
    }

    public start(): void {
        if (this.#running) return
        this.#log.info('Relay do outbox iniciado')
        this.#running = this.#loop()
    }

    /** Evento novo gravado: verifica antes do próximo ciclo. */
    public notify(): void {
        this.#wake?.()
    }

    /** Pendentes e idade do mais antigo (para o /health/ready e métricas). */
    public async stats(): Promise<{ pending: number; oldestAgeSeconds: number }> {
        const { pending, oldestCreatedAt } = await this.#options.store.stats()
        const oldestAgeSeconds = oldestCreatedAt ? Math.round((Date.now() - oldestCreatedAt.getTime()) / 1000) : 0
        this.#pendingGauge = { pending, oldestAgeSeconds }
        return this.#pendingGauge
    }

    public async stop(): Promise<void> {
        this.#stopped = true
        this.#wake?.()
        await this.#running
        const { pending } = await this.stats().catch(() => ({ pending: 0 }))
        if (pending > 0) this.#log.info(`Relay do outbox parado; ${pending} pendente(s) serão enviados na próxima execução`)
    }

    async #loop(): Promise<void> {
        let lastStats = 0
        while (!this.#stopped) {
            let sent = 0
            try {
                if (Date.now() - lastStats > 10_000) {
                    lastStats = Date.now()
                    await this.stats()
                }
                if (this.#options.bus.isConnected) {
                    if (this.#waitingForBus) {
                        this.#waitingForBus = false
                        this.#log.info('Barramento disponível: retomando a publicação do outbox')
                    }
                    sent = await this.#publishBatch()
                } else if (!this.#waitingForBus) {
                    this.#waitingForBus = true
                    const { pending } = await this.stats()
                    this.#log.warn(`Barramento indisponível: eventos ficam no outbox até a conexão voltar (${pending} pendentes)`)
                }
            } catch (err) {
                this.#log.error('Falha no relay do outbox', { err })
            }
            // lote cheio: provavelmente há mais; senão espera um aviso ou o próximo ciclo
            if (sent < this.#options.batchSize) await this.#idle()
        }
    }

    async #publishBatch(): Promise<number> {
        const { store, bus, batchSize, lockMs } = this.#options
        const records = await store.claim(batchSize, lockMs)
        for (const [index, record] of records.entries()) {
            const parent = propagation.extract(ROOT_CONTEXT, record.traceContext)
            try {
                const publish = () => bus.publish(record.exchange, record.routingKey, record.event, { messageId: record.id })
                await context.with(parent, publish)
                await store.markSent(record.id)
                publishedCounter.add(1, { exchange: record.exchange, event: record.event.event_name })
                if (record.attempts > 0) {
                    this.#log.info(`Evento ${record.event.event_name} publicado após ${record.attempts + 1} tentativa(s)`)
                }
            } catch (err) {
                failedCounter.add(1, { exchange: record.exchange, event: record.event.event_name })
                const message = err instanceof Error ? err.message : String(err)
                const delay = Math.min(1000 * 2 ** record.attempts, this.#options.maxBackoffMs)
                await store.reschedule(record.id, new Date(Date.now() + delay), message)
                if (err instanceof EventBusUnavailableError) {
                    // barramento caiu no meio do lote: libera o resto sem contar como tentativa
                    for (const rest of records.slice(index + 1)) {
                        await store.reschedule(rest.id, new Date(), message).catch(() => {})
                    }
                    return 0
                }
                this.#log.warn(`Falha ao publicar ${record.event.event_name} (tentativa ${record.attempts + 1}): ${message}`)
            }
        }
        return records.length
    }

    #idle(): Promise<void> {
        return new Promise<void>(resolve => {
            const timer = setTimeout(done, this.#options.pollIntervalMs)
            function done() {
                clearTimeout(timer)
                resolve()
            }
            this.#wake = done
        }).then(() => {
            this.#wake = undefined
        })
    }
}

