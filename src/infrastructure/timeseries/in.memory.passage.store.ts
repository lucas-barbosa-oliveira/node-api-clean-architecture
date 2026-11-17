import type { IPassageStore } from '../../application/port/passage.store.ts'
import { timeBounds, type Filter, type ListQuery, type Page } from '../../application/query/list.query.ts'
import type { TimeWindow } from '../../application/query/time.window.ts'
import type { Passage, PassageWindow } from '../../domain/model/passage.ts'
import { matches, queryDocs } from '../repository/in-memory/in.memory.query.ts'
import { appMetrics } from '../telemetry/metrics.ts'

/**
 * Série temporal em memória, para desenvolvimento e testes sem InfluxDB.
 * Reproduz o comportamento do InfluxPassageStore: chave = dispositivo + sentido + instante (sobrescreve),
 * janelas alinhadas à época Unix e janelas vazias com zero.
 */
export class InMemoryPassageStore implements IPassageStore {
    #points = new Map<string, Passage>()

    public async write(passages: Passage[]): Promise<void> {
        appMetrics.passagesWritten.add(passages.length, { store: 'memory' })
        for (const passage of passages) {
            this.#points.set(`${passage.deviceId}|${passage.direction}|${passage.occurredAt.getTime()}`, structuredClone(passage))
        }
    }

    public async list(query: ListQuery): Promise<Page<Passage>> {
        return queryDocs([...this.#points.values()].map(point => structuredClone(point)), query)
    }

    public async summarize(filter: Filter, window: TimeWindow): Promise<PassageWindow[]> {
        const { start = new Date(0), stop = new Date() } = timeBounds(filter, 'occurredAt')
        const first = Math.floor(start.getTime() / window.ms) * window.ms
        const windows = new Map<number, PassageWindow>()
        // como no Flux, a primeira janela começa no início do intervalo (e não no múltiplo da janela anterior a ele)
        for (let t = first; t < stop.getTime(); t += window.ms) {
            windows.set(t, { start: new Date(Math.max(t, start.getTime())), in: 0, out: 0, unknown: 0 })
        }

        for (const point of this.#points.values()) {
            if (!matches(point as unknown as Record<string, unknown>, filter)) continue
            const bucket = windows.get(Math.floor(point.occurredAt.getTime() / window.ms) * window.ms)
            if (bucket) bucket[point.direction]++
        }
        return [...windows.values()]
    }

    public async close(): Promise<void> {}
}
