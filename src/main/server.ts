import { buildContainer, type Container } from '../di/container.ts'
import { loadEnv } from '../di/env.ts'
import { buildLogger } from '../di/logger.ts'
import { registerEventBus } from '../presentation/eventbus/index.ts'
import { createApp } from './app.ts'

const env = loadEnv()
const logger = buildLogger(env)
const log = logger.child('app')
const port = Number(process.env.PORT ?? 3000)

log.info(
    `Iniciando ${env.APP_NAME} (repositórios: ${env.REPOSITORY_DRIVER}, fila: ${env.QUEUE_DRIVER}, `
    + `séries temporais: ${env.TIMESERIES_DRIVER}, barramento: ${env.EVENT_BUS_DRIVER})`,
)

// sinais tratados desde o início: um "docker stop" durante as tentativas de conexão também encerra
const startup = new AbortController()
const lifecycle: { stop?: () => Promise<void> } = {}
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        if (shuttingDown) return
        shuttingDown = true
        log.info(`${signal} recebido: encerrando...`)
        if (!lifecycle.stop) {
            startup.abort(new Error(`${signal} durante a inicialização`))
            process.exit(0)
        }
        lifecycle.stop().then(
            () => {
                log.info('Encerrado')
                process.exit(0)
            },
            err => {
                log.error('Falha no encerramento', { err })
                process.exit(1)
            },
        )
    })
}

const container: Container = await buildContainer(env, { logger, signal: startup.signal })
await container.recover() // pré-condição: antes de aceitar tráfego
await container.ensureAdmin()

// o barramento conecta em segundo plano: a API atende mesmo com o RabbitMQ fora do ar (eventos ficam em buffer)
registerEventBus(container.eventBus, { userService: container.userService, jobService: container.jobService })
container.eventBus.start()

const server = createApp(container).listen(port, () => {
    log.info(`Servidor HTTP ouvindo na porta ${port}`)
})
await container.scheduler.start() // tasks de startup e agendadas

lifecycle.stop = async () => {
    // 1) para de aceitar requisições; 2) agendador e fila terminam o que está em andamento; 3) fecha conexões
    await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeIdleConnections()
    })
    log.info('Servidor HTTP encerrado')
    await container.close()
}
