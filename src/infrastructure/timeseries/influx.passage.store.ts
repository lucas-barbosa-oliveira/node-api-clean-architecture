import {
    fluxDateTime,
    fluxDuration,
    fluxString,
    InfluxDB,
    Point,
    type QueryApi,
    type WriteApi,
} from '@influxdata/influxdb-client'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'
import type { IPassageStore } from '../../application/port/passage.store.ts'
import { timeBounds, type Filter, type ListQuery, type Page } from '../../application/query/list.query.ts'
import type { TimeWindow } from '../../application/query/time.window.ts'
import type { DeviceStatusSample, Passage, PassageDirection, PassageWindow } from '../../domain/model/passage.ts'
import { formatMs, redactUri } from '../resilience/retry.ts'
import { describeTls, readTlsClientOptions, type TlsClientConfig, type TlsClientOptions } from '../security/tls.ts'
import { appMetrics } from '../telemetry/metrics.ts'
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
export type InfluxConfig = { url: string; token: string; org: string; bucket: string; tls?: TlsClientConfig }

export class InfluxPassageStore implements IPassageStore {
    #writeApi: WriteApi
    #queryApi: QueryApi
    #bucket: string
    #monitor: InfluxConnectionMonitor
    #config: InfluxConfig
    #log: ILogger

    constructor(config: InfluxConfig, logger: ILogger = silentLogger) {
        this.#config = config
        this.#log = logger
        this.#bucket = config.bucket
        const tls = config.tls && readTlsClientOptions(config.tls)
        ;({ writeApi: this.#writeApi, queryApi: this.#queryApi } = this.#client(config.token, tls))
        logger.info(`Séries temporais no InfluxDB em ${redactUri(config.url)} (org "${config.org}", `
            + `bucket "${config.bucket}")${describeTls(config.tls)}`)
        this.#monitor = new InfluxConnectionMonitor(config.url, logger, { tls })
    }

    /** Token ou certificados renovados: cria um cliente novo; o anterior termina de gravar o que tinha. */
    public async reconfigure(settings: { token: string; tls?: TlsClientConfig }): Promise<void> {
        const tls = settings.tls && readTlsClientOptions(settings.tls)
        const previous = this.#writeApi
        ;({ writeApi: this.#writeApi, queryApi: this.#queryApi } = this.#client(settings.token, tls))
        this.#monitor.setTls(tls)
        await previous.close().catch(() => {})
        this.#log.info(`Cliente do InfluxDB refeito com token/certificados novos${describeTls(settings.tls)}`)
    }

    #client(token: string, tls: TlsClientOptions | undefined): { writeApi: WriteApi; queryApi: QueryApi } {
        const { url, org, bucket } = this.#config
        // transportOptions vão direto para o https.request do cliente: CA, certificado de cliente e SNI
        const client = new InfluxDB({ url, token, timeout: 10_000, transportOptions: tls })
        // sem buffer em segundo plano: cada lote é gravado (flush) antes de responder 202 à ESP32
        const writeApi = client.getWriteApi(org, bucket, 'ms', {
            maxRetries: 2,
            flushInterval: 0,
            writeFailed: (error, lines, attempt) => {
                this.#log.warn(`Falha ao gravar ${lines.length} ponto(s) no InfluxDB (tentativa ${attempt}): ${error.message}`)
            },
        })
        return { writeApi, queryApi: client.getQueryApi(org) }
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
        appMetrics.passagesWritten.add(passages.length, { store: 'influxdb' })
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

    /** Último resultado do ping periódico (para o /health/ready). */
    public get isReachable(): boolean {
        return this.#monitor.isUp
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
    #tls?: TlsClientOptions

    constructor(
        url: string,
        logger: ILogger,
        options: { upIntervalMs?: number; downIntervalMs?: number; tls?: TlsClientOptions } = {},
    ) {
        this.#url = url.replace(/\/+$/, '')
        this.#log = logger
        this.#tls = options.tls
        this.#upIntervalMs = options.upIntervalMs ?? 15_000
        this.#downIntervalMs = options.downIntervalMs ?? 5000
        void this.#check()
    }

    public get isUp(): boolean {
        return this.#state === 'up'
    }

    public setTls(tls: TlsClientOptions | undefined): void {
        this.#tls = tls
    }

    public stop(): void {
        this.#stopped = true
        clearTimeout(this.#timer)
    }

    async #check(): Promise<void> {
        try {
            this.#up(await ping(`${this.#url}/ping`, this.#tls))
        } catch (err) {
            this.#down(err instanceof Error ? err.message : String(err))
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

/**
 * GET /ping com node:http(s) (o fetch global não aceita CA nem certificado de cliente por requisição).
 * Resolve com a versão do InfluxDB (header X-Influxdb-Version).
 */
function ping(url: string, tls: TlsClientOptions | undefined): Promise<string | null> {
    const request = url.startsWith('https:') ? httpsRequest : httpRequest
    return new Promise((resolve, reject) => {
        const req = request(url, { method: 'GET', timeout: 3000, ...tls }, res => {
            res.resume()
            const status = res.statusCode ?? 0
            if (status < 200 || status >= 300) reject(new Error(`HTTP ${status}`))
            else resolve((res.headers['x-influxdb-version'] as string | undefined) ?? null)
        })
        req.on('timeout', () => req.destroy(new Error('sem resposta em 3s')))
        req.on('error', err => reject(new Error(errorMessage(err))))
        req.end()
    })
}

/** Erros de conexão do Node vêm agregados (IPv4 e IPv6): o primeiro já explica. */
function errorMessage(err: Error): string {
    if (err instanceof AggregateError && err.errors[0] instanceof Error) return err.errors[0].message
    return err.message || (err as { code?: string }).code || err.name
}
