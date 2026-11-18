import { buildContainer, type Container } from '../di/container.ts'
import { loadEnv } from '../di/env.ts'
import { buildLogger } from '../di/logger.ts'
import { registerEventBus } from '../presentation/eventbus/index.ts'
import { createApp } from './app.ts'
import express from 'express'
import { healthRoutes } from '../presentation/http/health.routes.ts'
import { startHealthServer, startHttpServer } from './http.server.ts'
import { shutdownTelemetry } from './telemetry.ts'

const env = loadEnv()
const logger = buildLogger(env)
const log = logger.child('app')

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

const { server, reloadTls } = startHttpServer(createApp(container), { port: env.PORT, tls: env.tls.server, logger: log })
if (reloadTls) {
    // certificado renovado em disco (cert-manager, certbot...): kill -HUP <pid> troca sem derrubar conexões
    process.on('SIGHUP', () => {
        try {
            reloadTls()
        } catch (err) {
            log.error('Falha ao recarregar o certificado TLS: o anterior continua em uso', { err })
        }
    })
    // certificado renovado em disco pelo Vault Agent ou cert-manager: recarrega sozinho, sem sinal
    const tls = env.tls.server
    if (tls) {
        container.secretWatcher.add({
            name: 'servidor HTTPS',
            files: [tls.certFile, tls.keyFile, ...(tls.caFile ? [tls.caFile] : [])],
            reload: async () => reloadTls(),
        })
    }
}
await container.secretWatcher.start(env.SECRETS_RELOAD_INTERVAL_MS)
const healthServer = env.HEALTH_PORT
    ? startHealthServer(express().use(healthRoutes(container.health)), { port: env.HEALTH_PORT, logger: log })
    : undefined
await container.scheduler.start() // tasks de startup e agendadas

container.outboxRelay.start()

lifecycle.stop = async () => {
    container.health.markShuttingDown() // /health/ready passa a responder 503: o balanceador para de mandar tráfego
    // 1) para de aceitar requisições; 2) agendador e fila terminam o que está em andamento; 3) fecha conexões
    await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeIdleConnections()
    })
    log.info(`Servidor ${env.tls.server ? 'HTTPS' : 'HTTP'} encerrado`)
    healthServer?.close()
    await container.close()
    await shutdownTelemetry() // envia os últimos spans
}
