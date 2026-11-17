import { z } from 'zod'
import { LOG_LEVELS } from '../application/port/logger.ts'

const repoSchema = z.discriminatedUnion('REPOSITORY_DRIVER', [
    z.object({ REPOSITORY_DRIVER: z.literal('memory') }),
    z.object({
        REPOSITORY_DRIVER: z.literal('mongo'),
        MONGO_URI: z.string().min(1),
        MONGO_DB: z.string().default('app'),
    }),
])

const queueSchema = z.discriminatedUnion('QUEUE_DRIVER', [
    z.object({ QUEUE_DRIVER: z.literal('in-process') }),
    z.object({ QUEUE_DRIVER: z.literal('redis'), REDIS_URL: z.string().min(1) }),
])

const timeseriesSchema = z.discriminatedUnion('TIMESERIES_DRIVER', [
    z.object({ TIMESERIES_DRIVER: z.literal('memory') }),
    z.object({
        TIMESERIES_DRIVER: z.literal('influx'),
        INFLUX_URL: z.string().min(1),
        INFLUX_TOKEN: z.string().min(1),
        INFLUX_ORG: z.string().min(1),
        INFLUX_BUCKET: z.string().min(1),
    }),
])

const eventBusSchema = z.discriminatedUnion('EVENT_BUS_DRIVER', [
    z.object({ EVENT_BUS_DRIVER: z.literal('memory') }),
    z.object({
        EVENT_BUS_DRIVER: z.literal('rabbitmq'),
        /** amqp://usuario:senha@host:5672/vhost */
        RABBITMQ_URI: z.string().regex(/^amqps?:\/\//, 'RABBITMQ_URI deve começar com amqp:// ou amqps://'),
        RABBITMQ_RETRY_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(2000),
        RABBITMQ_RPC_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
    }),
])

const observabilitySchema = z.object({
    /** Nome do serviço: rótulo dos logs, campo "service" da auditoria e nome da fila/exchange RPC no barramento. */
    APP_NAME: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'APP_NAME: use letras, números, - e _')
        .default('api-clean-architecture'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    /** text (legível) ou json (uma linha JSON por log, para agregadores). */
    LOG_FORMAT: z.enum(['text', 'json']).default('text'),
    /** Eventos guardados enquanto o barramento está fora do ar (os mais antigos são descartados acima disso). */
    EVENT_BUS_BUFFER_SIZE: z.coerce.number().int().min(0).max(100_000).default(1000),
    /** Publica um RequestAuditEvent por requisição. */
    AUDIT_ENABLED: z.stringbool().default(true),
    /** Prefixos de caminho que não são auditados, separados por vírgula. */
    AUDIT_IGNORE_PATHS: z
        .string()
        .default('/health,/.well-known,/reference')
        .transform(value => value.split(',').map(path => path.trim()).filter(Boolean)),
    /** Corpos maiores que isso (pedido ou resposta) vão para a auditoria só com o tamanho. */
    AUDIT_MAX_BODY_BYTES: z.coerce.number().int().min(0).max(1_048_576).default(16_384),
    /** Documentação OpenAPI e Swagger UI em /reference. */
    API_DOCS_ENABLED: z.stringbool().default(true),
})

const commonSchema = z.object({
    /** Duração simulada do relatório de exemplo (ms). */
    REPORT_DURATION_MS: z.coerce.number().int().min(0).default(3000),
})

const optional = z.string().trim().min(1).optional()

const authSchema = z
    .object({
        /** Claim "iss": precisa ser igual à "key" da credencial JWT do consumer no Kong (kong/kong.template.yml). */
        JWT_ISSUER: z.string().min(1).default('api-clean-architecture'),
        JWT_AUDIENCE: z.string().min(1).default('api-clean-architecture'),
        /** Validade do access token. Curta: a renovação é feita com o refresh token. */
        JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
        /** Validade absoluta da sessão (refresh token). Depois dela, só com novo login. */
        REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).max(90 * 86_400).default(7 * 86_400),
        /** Validade do código de pareamento de dispositivos (10 min). */
        PAIRING_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
        /** Validade do token do dispositivo (1 ano, o máximo que o plugin jwt do Kong aceita). Revogação é imediata. */
        DEVICE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(86_400).max(365 * 86_400).default(365 * 86_400),
        /** Par de chaves RSA (PEM). Sem eles, a API gera chaves temporárias (só desenvolvimento). */
        JWT_PRIVATE_KEY_PATH: optional,
        JWT_PUBLIC_KEY_PATH: optional,
        /** Administrador criado na inicialização, se ainda não existir. */
        ADMIN_NAME: z.string().trim().min(2).default('Administrador'),
        ADMIN_EMAIL: optional,
        ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD deve ter ao menos 8 caracteres').optional(),
    })
    .refine(env => Boolean(env.JWT_PRIVATE_KEY_PATH) === Boolean(env.JWT_PUBLIC_KEY_PATH), {
        message: 'Defina JWT_PRIVATE_KEY_PATH e JWT_PUBLIC_KEY_PATH juntos',
    })
    .refine(env => Boolean(env.ADMIN_EMAIL) === Boolean(env.ADMIN_PASSWORD), {
        message: 'Defina ADMIN_EMAIL e ADMIN_PASSWORD juntos',
    })

export type Env = z.infer<typeof repoSchema> &
    z.infer<typeof queueSchema> &
    z.infer<typeof timeseriesSchema> &
    z.infer<typeof eventBusSchema> &
    z.infer<typeof observabilitySchema> &
    z.infer<typeof commonSchema> &
    z.infer<typeof authSchema>

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
    const input = {
        REPOSITORY_DRIVER: 'memory',
        QUEUE_DRIVER: 'in-process',
        TIMESERIES_DRIVER: 'memory',
        EVENT_BUS_DRIVER: 'memory',
        ...source,
    }
    const env: Env = {
        ...repoSchema.parse(input),
        ...queueSchema.parse(input),
        ...timeseriesSchema.parse(input),
        ...eventBusSchema.parse(input),
        ...observabilitySchema.parse(input),
        ...commonSchema.parse(input),
        ...authSchema.parse(input),
    }
    if (env.QUEUE_DRIVER === 'redis' && env.REPOSITORY_DRIVER === 'memory') {
        throw new Error(
            'QUEUE_DRIVER=redis exige REPOSITORY_DRIVER=mongo (o estado dos jobs precisa ser compartilhado entre instâncias)',
        )
    }
    return env
}
