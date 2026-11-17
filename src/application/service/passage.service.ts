import { hasScope, type Actor } from '../../domain/auth/actor.ts'
import { SCOPES } from '../../domain/auth/scopes.ts'
import { ForbiddenError, ValidationError } from '../../domain/error/index.ts'
import type { DeviceStatusSample, Passage, PassageWindow } from '../../domain/model/passage.ts'
import { validatePassageBatch } from '../../domain/validator/device.validator.ts'
import type { IDeviceRepository } from '../port/device.repository.ts'
import type { IPassageStore } from '../port/passage.store.ts'
import { and, timeBounds, type ListQuery, type Page } from '../query/list.query.ts'
import { MAX_WINDOWS, type TimeWindow } from '../query/time.window.ts'

const DEFAULT_SUMMARY_RANGE_MS = 86_400_000

export class PassageService {
    #store: IPassageStore
    #devices: IDeviceRepository

    constructor(store: IPassageStore, devices: IDeviceRepository) {
        this.#store = store
        this.#devices = devices
    }

    /**
     * Recebe um lote de passagens da ESP32. O dispositivo e o cliente vêm do token;
     * o clientId do payload precisa ser o mesmo do dispositivo (não dá para gravar em nome de outro cliente).
     */
    public async ingest(actor: Actor, deviceId: string, input: unknown): Promise<{ accepted: number }> {
        if (actor.role !== 'device' || actor.userId !== deviceId) {
            throw new ForbiddenError('O token não pertence a este dispositivo')
        }
        const batch = validatePassageBatch(input)
        if (batch.clientId !== actor.clientId) {
            throw new ForbiddenError('clientId não corresponde ao cliente do dispositivo')
        }

        const receivedAt = new Date()
        const unique = new Map(batch.events.map(event => [event.eventId, event]))
        const passages: Passage[] = [...unique.values()].map(event => ({
            ...event,
            deviceId,
            clientId: batch.clientId,
            receivedAt,
        }))
        const status: DeviceStatusSample | undefined = batch.device && {
            ...batch.device,
            deviceId,
            clientId: batch.clientId,
            receivedAt,
        }

        await this.#store.write(passages, status)
        await this.#devices.markSeen(deviceId, receivedAt, batch.device?.firmware)
        return { accepted: passages.length }
    }

    /** Cliente vê as passagens dos próprios dispositivos; passages:read:any vê todas. */
    public list(actor: Actor, query: ListQuery): Promise<Page<Passage>> {
        return this.#store.list({ ...query, filter: and(this.#access(actor), query.filter) })
    }

    /**
     * Contagem por sentido em janelas de tempo. Sem início no filtro, considera as últimas 24 horas.
     * O fim é limitado ao instante atual (sem janelas vazias no futuro, ex.: period=1d termina às 23:59:59 de hoje).
     */
    public async summarize(actor: Actor, query: ListQuery, window: TimeWindow): Promise<PassageWindow[]> {
        let filter = and(this.#access(actor), query.filter)
        const bounds = timeBounds(filter, 'occurredAt')
        const now = new Date()
        const stop = bounds.stop && bounds.stop < now ? bounds.stop : now
        const start = bounds.start ?? new Date(stop.getTime() - DEFAULT_SUMMARY_RANGE_MS)
        if (!bounds.start) filter = and(filter, { occurredAt: { $gte: start } })
        if (!bounds.stop || bounds.stop > now) filter = and(filter, { occurredAt: { $lt: now } })

        if ((stop.getTime() - start.getTime()) / window.ms > MAX_WINDOWS) {
            throw new ValidationError('Parâmetros de consulta inválidos', [
                { path: ['window'], message: `Intervalo grande demais para a janela: no máximo ${MAX_WINDOWS} janelas` },
            ])
        }
        return this.#store.summarize(filter, window)
    }

    #access(actor: Actor) {
        return hasScope(actor, SCOPES.passagesReadAny) ? {} : { clientId: actor.userId }
    }
}
