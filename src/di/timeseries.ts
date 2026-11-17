import type { ILogger } from '../application/port/logger.ts'
import type { IPassageStore } from '../application/port/passage.store.ts'
import { InMemoryPassageStore } from '../infrastructure/timeseries/in.memory.passage.store.ts'
import type { Env } from './env.ts'

/** Escolhe o armazenamento de séries temporais pela variável TIMESERIES_DRIVER (memory | influx). */
export async function buildPassageStore(env: Env, logger: ILogger): Promise<IPassageStore> {
    if (env.TIMESERIES_DRIVER === 'influx') {
        // import dinâmico: o cliente do InfluxDB só é carregado quando o driver influx é usado
        const { InfluxPassageStore } = await import('../infrastructure/timeseries/influx.passage.store.ts')
        const { INFLUX_URL: url, INFLUX_TOKEN: token, INFLUX_ORG: org, INFLUX_BUCKET: bucket } = env
        return new InfluxPassageStore({ url, token, org, bucket }, logger.child('influxdb'))
    }
    logger.child('timeseries').info('Séries temporais em memória (TIMESERIES_DRIVER=memory): os dados somem ao reiniciar')
    return new InMemoryPassageStore()
}
