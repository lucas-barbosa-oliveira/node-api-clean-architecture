import { metrics } from '@opentelemetry/api'

/**
 * Métricas de negócio, além das automáticas (latência HTTP, Mongo, Redis, RabbitMQ, runtime).
 * Sem o SDK carregado (src/main/telemetry.ts), a API do OpenTelemetry é no-op: custo zero.
 */
const meter = metrics.getMeter('api')

export const appMetrics = {
    jobsCompleted: meter.createCounter('jobs.completed', { description: 'Jobs finalizados, por tipo e status' }),
    jobDuration: meter.createHistogram('jobs.duration', { description: 'Duração da execução dos jobs', unit: 's' }),
    passagesWritten: meter.createCounter('passages.written', { description: 'Passagens gravadas na série temporal' }),
    deadLettered: meter.createCounter('eventbus.dead_lettered', {
        description: 'Mensagens recebidas que foram para a fila <serviço>.dlq (subscriber falhou ou mensagem inválida)',
    }),
}
