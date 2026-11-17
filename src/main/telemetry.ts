/**
 * OpenTelemetry: traces (OTLP -> Jaeger) e métricas (formato Prometheus em :9464/metrics).
 * Precisa carregar antes de qualquer módulo instrumentado (http, express, mongodb, ioredis, amqplib):
 *
 *   node --import ./src/main/telemetry.ts src/main/server.ts
 *
 * Fica desligado sem OTEL_EXPORTER_OTLP_ENDPOINT (ou com OTEL_SDK_DISABLED=true): sem custo em testes e no modo rápido.
 * Variáveis padrão do OpenTelemetry: OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_TRACES_SAMPLER, etc.
 */
import { register } from 'node:module'

type Shutdown = () => Promise<void>
let shutdown: Shutdown = async () => {}

const enabled = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) && process.env.OTEL_SDK_DISABLED !== 'true'

if (enabled) {
    // a aplicação é ESM: o hook (import-in-the-middle) permite instrumentar módulos carregados com import
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)

    const [
        { NodeSDK },
        { OTLPTraceExporter },
        { PrometheusExporter },
        { HttpInstrumentation },
        { ExpressInstrumentation },
        { MongoDBInstrumentation },
        { IORedisInstrumentation },
        { AmqplibInstrumentation },
        { RuntimeNodeInstrumentation },
    ] = await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/exporter-prometheus'),
        import('@opentelemetry/instrumentation-http'),
        import('@opentelemetry/instrumentation-express'),
        import('@opentelemetry/instrumentation-mongodb'),
        import('@opentelemetry/instrumentation-ioredis'),
        import('@opentelemetry/instrumentation-amqplib'),
        import('@opentelemetry/instrumentation-runtime-node'),
    ])

    const metricsPort = Number(process.env.OTEL_METRICS_PORT ?? 9464)
    // verificações de saúde, arquivos da documentação e a coleta de métricas não viram trace (só ruído)
    const ignored = /^\/(health|reference\/assets|metrics)(\/|$|\?)/

    const sdk = new NodeSDK({
        serviceName: process.env.OTEL_SERVICE_NAME ?? process.env.APP_NAME ?? 'api-clean-architecture',
        traceExporter: new OTLPTraceExporter(),
        metricReaders: [new PrometheusExporter({ port: metricsPort })],
        instrumentations: [
            new HttpInstrumentation({ ignoreIncomingRequestHook: req => ignored.test(req.url ?? '') }),
            new ExpressInstrumentation(),
            new MongoDBInstrumentation({ enhancedDatabaseReporting: false }), // não grava valores das consultas nos spans
            new IORedisInstrumentation(),
            new AmqplibInstrumentation(), // propaga o trace nos headers das mensagens do RabbitMQ
            new RuntimeNodeInstrumentation(), // event loop, heap, GC
        ],
    })
    sdk.start()
    shutdown = () => sdk.shutdown()
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    process.stdout.write(`[telemetry] traces para ${endpoint}; métricas em :${metricsPort}/metrics\n`)
}

/** Envia os spans pendentes antes de o processo sair (chamado no encerramento gracioso). */
export function shutdownTelemetry(): Promise<void> {
    return shutdown().catch(() => {})
}
