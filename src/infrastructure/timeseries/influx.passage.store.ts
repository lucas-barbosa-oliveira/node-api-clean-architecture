import {
    fluxDateTime,
    fluxDuration,
    fluxString,
    InfluxDB,
    Point,
    type QueryApi,
    type WriteApi,
} from '@influxdata/influxdb-client'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import type { IPassageStore } from '../../application/port/passage.store.ts'
import { timeBounds, type Filter, type ListQuery, type Page } from '../../application/query/list.query.ts'
import type { TimeWindow } from '../../application/query/time.window.ts'
import type { DeviceStatusSample, Passage, PassageDirection, PassageWindow } from '../../domain/model/passage.ts'
import { formatMs, redactUri } from '../resilience/retry.ts'
import { toFluxPredicate } from './flux.filter.ts'

/**
 * Modelo no InfluxDB (bucket configurado em INFLUX_BUCKET):
 *
 *   passage        tags: clientId, deviceId, direction   fields: count=1i, eventId, sequence, receivedAtMs   time: occurredAt
 *   device_status  tags: clientId, deviceId              fields: firmware, uptimeSeconds, rssi             time: receivedAt
 *
 * Tags são indexadas e têm baixa cardinalidade (número de dispositivos); o eventId fica em field.
 * Um ponto é identificado por medição + tags + tempo: reenviar o mesmo evento sobrescreve (idempotente).
 */
export class InfluxPassageStore implements IPassageStore {
    #writeApi: WriteApi
    #queryApi: QueryApi
    #bucket: string
    #monitor: InfluxConnectionMonitor

    constructor(
        config: { url: string; token: string; org: string; bucket: string },
        logger: ILogger = silentLogger,
    ) {
        const client = new InfluxDB({ url: config.url, token: config.token, timeout: 10_000 })
        // sem buffer em segundo plano: cada lote é gravado (flush) antes de responder 202 à ESP32
        this.#writeApi = client.getWriteApi(config.org, config.bucket, 'ms', {
            maxRetries: 2,
            flushInterval: 0,
            writeFailed: (error, lines, attempt) => {
                logger.warn(`Falha ao gravar ${lines.length} ponto(s) no InfluxDB (tentativa ${attempt}): ${error.message}`)
            },
        })
        this.#queryApi = client.getQueryApi(config.org)
        this.#bucket = config.bucket
        logger.info(`Séries temporais no InfluxDB em ${redactUri(config.url)} (org "${config.org}", bucket "${config.bucket}")`)
        this.#monitor = new InfluxConnectionMonitor(config.url, logger)
    }

    public async write(passages: Passage[], status?: DeviceStatusSample): Promise<void> {
        const points = passages.map(p => {
            const point = new Point('passage')
                .tag('clientId', p.clientId)
                .tag('deviceId', p.deviceId)
                .tag('direction', p.direction)
                .intField('count', 1)
                .stringField('eventId', p.eventId)
                .intField('receivedAtMs', p.receivedAt.getTime())
                .timestamp(p.occurredAt)
            return p.sequence === undefined ? point : point.intField('sequence', p.sequence)
        })
        if (status) {
            const point = new Point('device_status')
                .tag('clientId', status.clientId)
                .tag('deviceId', status.deviceId)
                .timestamp(status.receivedAt)
            if (status.firmware !== undefined) point.stringField('firmware', status.firmware)
            if (status.uptimeSeconds !== undefined) point.intField('uptimeSeconds', status.uptimeSeconds)
            if (status.rssi !== undefined) point.intField('rssi', status.rssi)
            if (point.fields && Object.keys(point.fields).length > 0) points.push(point)
        }
        this.#writeApi.writePoints(points)
        await this.#writeApi.flush()
    }

    public async list(query: ListQuery): Promise<Page<Passage>> {
        const base = `${this.#from(query.filter)}
  |> filter(fn: (r) => r._measurement == "passage")
  |> filter(fn: (r) => ${toFluxPredicate(query.filter)})
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> group()`
        const desc = (query.sort.occurredAt ?? -1) === -1
        const [rows, totals] = await Promise.all([
            this.#queryApi.collectRows<Record<string, unknown>>(
                `${base}\n  |> sort(columns: ["_time"], desc: ${desc})\n  |> limit(n: ${query.limit}, offset: ${query.skip})`,
            ),
            this.#queryApi.collectRows<{ eventId?: number }>(`${base}\n  |> count(column: "eventId")`),
        ])
        return {
            items: rows.map(row => ({
                eventId: String(row.eventId),
                occurredAt: new Date(String(row._time)),
                direction: row.direction as PassageDirection,
                ...(row.sequence != null && { sequence: Number(row.sequence) }),
                deviceId: String(row.deviceId),
                clientId: String(row.clientId),
                receivedAt: new Date(Number(row.receivedAtMs)),
            })),
            total: Number(totals[0]?.eventId ?? 0),
        }
    }

    public async summarize(filter: Filter, window: TimeWindow): Promise<PassageWindow[]> {
        const rows = await this.#queryApi.collectRows<Record<string, unknown>>(`${this.#from(filter)}
  |> filter(fn: (r) => r._measurement == "passage" and r._field == "count")
  |> filter(fn: (r) => ${toFluxPredicate(filter)})
  |> group(columns: ["direction"])
  |> aggregateWindow(every: ${String(fluxDuration(window.every))}, fn: sum, createEmpty: true, timeSrc: "_start")
  |> pivot(rowKey: ["_time"], columnKey: ["direction"], valueColumn: "_value")
  |> group()
  |> sort(columns: ["_time"])`)
        return rows.map(row => ({
            start: new Date(String(row._time)),
            in: Number(row.in ?? 0),
            out: Number(row.out ?? 0),
            unknown: Number(row.unknown ?? 0),
        }))
    }

    public async close(): Promise<void> {
        this.#monitor.stop()
        await this.#writeApi.close()
    }

    /** O range usa os limites de occurredAt do filtro (o Flux exige início); sem eles, o bucket inteiro até agora. */
    #from(filter: Filter): string {
        const { start, stop } = timeBounds(filter, 'occurredAt')
        const startExpr = String(fluxDateTime((start ?? new Date(0)).toISOString()))
        const stopExpr = stop ? String(fluxDateTime(stop.toISOString())) : 'now()'
        return `from(bucket: ${String(fluxString(this.#bucket))})\n  |> range(start: ${startExpr}, stop: ${stopExpr})`
    }
}

/**
 * O InfluxDB é acessado por HTTP, sem conexão permanente: para registrar quando ele fica indisponível
 * e quando volta, um GET /ping é feito periodicamente (mais vezes enquanto estiver fora do ar).
 */
export class InfluxConnectionMonitor {
    #url: string
    #log: ILogger
    #timer?: NodeJS.Timeout
    #state: 'unknown' | 'up' | 'down' = 'unknown'
    #connectedBefore = false
    #failures = 0
    #stopped = false
    #upIntervalMs: number
    #downIntervalMs: number

    constructor(url: string, logger: ILogger, options: { upIntervalMs?: number; downIntervalMs?: number } = {}) {
        this.#url = url.replace(/\/+$/, '')
        this.#log = logger
        this.#upIntervalMs = options.upIntervalMs ?? 15_000
        this.#downIntervalMs = options.downIntervalMs ?? 5000
        void this.#check()
    }

    public get isUp(): boolean {
        return this.#state === 'up'
    }

    public stop(): void {
        this.#stopped = true
        clearTimeout(this.#timer)
    }

    async #check(): Promise<void> {
        try {
            const res = await fetch(`${this.#url}/ping`, { signal: AbortSignal.timeout(3000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            this.#up(res.headers.get('x-influxdb-version'))
        } catch (err) {
            this.#down(err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err))
        }
        if (this.#stopped) return
        this.#timer = setTimeout(() => void this.#check(), this.#state === 'up' ? this.#upIntervalMs : this.#downIntervalMs)
        this.#timer.unref() // não segura o processo aberto
    }

    #up(version: string | null): void {
        if (this.#state === 'up') return
        if (this.#connectedBefore) {
            this.#log.info(`Conexão com InfluxDB restabelecida (após ${this.#failures} tentativa(s) sem sucesso)`)
        } else {
            this.#log.info(`Conexão com InfluxDB estabelecida${version ? ` (versão ${version})` : ''}`)
        }
        this.#state = 'up'
        this.#connectedBefore = true
        this.#failures = 0
    }

    #down(reason: string): void {
        if (this.#stopped) return
        const next = formatMs(this.#downIntervalMs)
        if (this.#state === 'up') {
            this.#log.warn(`Conexão com InfluxDB perdida: ${reason}. Tentando reconectar a cada ${next}`)
        } else {
            this.#failures++
            const verb = this.#connectedBefore ? 'reconexão' : 'conexão'
            this.#log.warn(`Tentativa ${this.#failures} de ${verb} com InfluxDB falhou: ${reason}. Nova tentativa em ${next}`)
        }
        this.#state = 'down'
    }
}
