import type { IEventBus } from '../application/port/event.bus.ts'
import type { ILogger } from '../application/port/logger.ts'
import { InMemoryEventBus } from '../infrastructure/eventbus/in.memory.event.bus.ts'
import type { Reloadable } from '../infrastructure/secrets/secret.file.watcher.ts'
import type { Env } from './env.ts'
import { currentSecret, watchedFiles } from './secrets.ts'

/** Escolhe o barramento pela variável EVENT_BUS_DRIVER (memory | rabbitmq). */
export async function buildEventBus(env: Env, logger: ILogger): Promise<{ bus: IEventBus; reloadables: Reloadable[] }> {
    if (env.EVENT_BUS_DRIVER === 'rabbitmq') {
        // import dinâmico: a biblioteca AMQP só é carregada quando o driver rabbitmq é usado
        const { RabbitMqEventBus } = await import('../infrastructure/eventbus/rabbitmq.event.bus.ts')
        const rabbitEnv = env
        const credentials = () => {
            const username = currentSecret(rabbitEnv, 'RABBITMQ_USERNAME')
            const password = currentSecret(rabbitEnv, 'RABBITMQ_PASSWORD')
            return username || password ? { username, password } : undefined
        }
        const bus = new RabbitMqEventBus({
            uri: env.RABBITMQ_URI,
            service: env.APP_NAME,
            logger: logger.child('rabbitmq'),
            retryIntervalMs: env.RABBITMQ_RETRY_INTERVAL_MS,
            rpcTimeoutMs: env.RABBITMQ_RPC_TIMEOUT_MS,
            tls: env.tls.rabbitmq,
            credentials: credentials(),
            subscriberAttempts: env.RABBITMQ_SUBSCRIBER_ATTEMPTS,
        })
        return {
            bus,
            reloadables: [{
                name: 'rabbitmq',
                files: watchedFiles(env, ['RABBITMQ_USERNAME', 'RABBITMQ_PASSWORD'], env.tls.rabbitmq),
                reload: () => bus.reconfigure({ tls: rabbitEnv.tls.rabbitmq, credentials: credentials() }),
            }],
        }
    }
    return { bus: new InMemoryEventBus({ service: env.APP_NAME, logger: logger.child('eventbus') }), reloadables: [] }
}
