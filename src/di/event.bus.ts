import type { IEventBus } from '../application/port/event.bus.ts'
import type { ILogger } from '../application/port/logger.ts'
import { InMemoryEventBus } from '../infrastructure/eventbus/in.memory.event.bus.ts'
import type { Env } from './env.ts'

/** Escolhe o barramento pela variável EVENT_BUS_DRIVER (memory | rabbitmq). */
export async function buildEventBus(env: Env, logger: ILogger): Promise<IEventBus> {
    if (env.EVENT_BUS_DRIVER === 'rabbitmq') {
        // import dinâmico: a biblioteca AMQP só é carregada quando o driver rabbitmq é usado
        const { RabbitMqEventBus } = await import('../infrastructure/eventbus/rabbitmq.event.bus.ts')
        return new RabbitMqEventBus({
            uri: env.RABBITMQ_URI,
            service: env.APP_NAME,
            logger: logger.child('rabbitmq'),
            retryIntervalMs: env.RABBITMQ_RETRY_INTERVAL_MS,
            rpcTimeoutMs: env.RABBITMQ_RPC_TIMEOUT_MS,
            bufferSize: env.EVENT_BUS_BUFFER_SIZE,
        })
    }
    return new InMemoryEventBus({ service: env.APP_NAME, logger: logger.child('eventbus') })
}
