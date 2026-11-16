import { buildContainer } from '../di/container.ts'
import { createApp } from './app.ts'

const port = Number(process.env.PORT ?? 3000)

const container = await buildContainer()
await container.recover() // pré-condição: antes de aceitar tráfego
await container.ensureAdmin()

const server = createApp(container).listen(port, () => {
    console.log(`API ouvindo em http://localhost:${port}`)
})
await container.scheduler.start() // tasks de startup e agendadas

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        if (shuttingDown) return
        shuttingDown = true
        console.log(`${signal} recebido: encerrando...`)
        // 1) para de aceitar requisições; 2) agendador e fila terminam o que está em andamento; 3) fecha conexões
        server.close(async () => {
            await container.close()
            process.exit(0)
        })
        server.closeIdleConnections()
    })
}
