import type { HealthCheck } from '../application/port/health.check.ts'
import type { ILogger } from '../application/port/logger.ts'
import type { IPassageStore } from '../application/port/passage.store.ts'
import { InMemoryPassageStore } from '../infrastructure/timeseries/in.memory.passage.store.ts'
import type { Env } from './env.ts'

/** Escolhe o armazenamento de séries temporais pela variável TIMESERIES_DRIVER (memory | influx). */
export type TimeSeries = { store: IPassageStore; healthChecks: HealthCheck[] }

export async function buildPassageStore(env: Env, logger: ILogger): Promise<TimeSeries> {
    if (env.TIMESERIES_DRIVER === 'influx') {
        // import dinâmico: o cliente do InfluxDB só é carregado quando o driver influx é usado
        const { InfluxPassageStore } = await import('../infrastructure/timeseries/influx.passage.store.ts')
        const { INFLUX_URL: url, INFLUX_TOKEN: token, INFLUX_ORG: org, INFLUX_BUCKET: bucket } = env
        const store = new InfluxPassageStore({ url, token, org, bucket }, logger.child('influxdb'))
        // não crítico: só os envios das ESP32 e as consultas de passagens dependem dele
        const influx: HealthCheck = {
            name: 'influxdb',
            critical: false,
            check: async () => ({ status: store.isReachable ? 'up' : 'down' }),
        }
        return { store, healthChecks: [influx] }
    }
    logger.child('timeseries').info('Séries temporais em memória (TIMESERIES_DRIVER=memory): os dados somem ao reiniciar')
    return { store: new InMemoryPassageStore(), healthChecks: [] }
}
