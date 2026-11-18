import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { LOG_LEVELS } from '../application/port/logger.ts'
import { USER_ROLES } from '../domain/model/user.ts'
import type { TlsClientConfig, TlsServerConfig } from '../infrastructure/security/tls.ts'

const optional = z.string().trim().min(1).optional()

/**
 * Variáveis de TLS de cada conexão de saída, com o prefixo do serviço (MONGO_TLS, REDIS_TLS_CA_FILE...).
 * O TLS liga com <PREFIXO>_TLS=true ou com o esquema seguro na URL (rediss://, amqps://, https://, tls=true no Mongo).
 */
const tlsClientFields = {
    TLS: z.stringbool().default(false),
    TLS_CA_FILE: optional,
    TLS_CERT_FILE: optional,
    TLS_KEY_FILE: optional,
    TLS_SERVERNAME: optional,
    TLS_REJECT_UNAUTHORIZED: z.stringbool().default(true),
}
type TlsClientFields<P extends string> = {
    [K in keyof typeof tlsClientFields as `${P}_${K}`]: (typeof tlsClientFields)[K]
}
function tlsClientShape<P extends string>(prefix: P): TlsClientFields<P> {
    const entries = Object.entries(tlsClientFields).map(([key, schema]) => [`${prefix}_${key}`, schema])
    return Object.fromEntries(entries) as TlsClientFields<P>
}

const repoSchema = z.discriminatedUnion('REPOSITORY_DRIVER', [
    z.object({ REPOSITORY_DRIVER: z.literal('memory') }),
    z.object({
        REPOSITORY_DRIVER: z.literal('mongo'),
        MONGO_URI: z.string().min(1),
        MONGO_DB: z.string().default('app'),
        /** Credenciais fora da URI (ex.: usuário dinâmico do Vault, em arquivo: MONGO_USERNAME_FILE/MONGO_PASSWORD_FILE). */
        MONGO_USERNAME: optional,
        MONGO_PASSWORD: optional,
        MONGO_AUTH_SOURCE: z.string().trim().min(1).default('admin'),
        /** Cria os índices na inicialização. Em produção, false: os índices vêm de npm run db:migrate (job do deploy). */
        MONGO_AUTO_INDEX: z.stringbool().default(true),
        ...tlsClientShape('MONGO'),
    }),
])

const queueSchema = z.discriminatedUnion('QUEUE_DRIVER', [
    z.object({ QUEUE_DRIVER: z.literal('in-process') }),
    z.object({
        QUEUE_DRIVER: z.literal('redis'),
        REDIS_URL: z.string().min(1),
        /** Prefixo das chaves do BullMQ no Redis: separa ambientes que compartilham o mesmo Redis (ex.: testes). */
        QUEUE_PREFIX: z.string().regex(/^[\w-]+$/).default('bull'),
        REDIS_USERNAME: optional,
        REDIS_PASSWORD: optional,
        ...tlsClientShape('REDIS'),
    }),
])

const timeseriesSchema = z.discriminatedUnion('TIMESERIES_DRIVER', [
    z.object({ TIMESERIES_DRIVER: z.literal('memory') }),
    z.object({
        TIMESERIES_DRIVER: z.literal('influx'),
        INFLUX_URL: z.string().min(1),
        INFLUX_TOKEN: z.string().min(1),
        INFLUX_ORG: z.string().min(1),
        INFLUX_BUCKET: z.string().min(1),
        ...tlsClientShape('INFLUX'),
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
        /** Substituem os da URI (ex.: usuário dinâmico do Vault). */
        RABBITMQ_USERNAME: optional,
        RABBITMQ_PASSWORD: optional,
        /** Tentativas de um subscriber antes de mandar a mensagem para a fila <APP_NAME>.dlq. */
        RABBITMQ_SUBSCRIBER_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
        ...tlsClientShape('RABBITMQ'),
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
    /** Intervalo com que o relay procura eventos novos no outbox (gravados por outras instâncias). */
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
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

const serverSchema = z.object({
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    /**
     * Porta só com /health, /health/live e /health/ready, em HTTP (0 desliga). Para as probes do Kubernetes quando a
     * porta principal exige certificado de cliente (o kubelet não apresenta um).
     */
    HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(0),
    /** HTTPS no servidor da API (em vez de HTTP). */
    SERVER_TLS: z.stringbool().default(false),
    SERVER_TLS_CERT_FILE: optional,
    SERVER_TLS_KEY_FILE: optional,
    /** CA dos certificados de cliente aceitos (mTLS). */
    SERVER_TLS_CA_FILE: optional,
    /** none: qualquer cliente TLS; require: só clientes com certificado assinado por SERVER_TLS_CA_FILE (ex.: o Kong). */
    SERVER_TLS_CLIENT_AUTH: z.enum(['none', 'require']).default('none'),
    SERVER_TLS_MIN_VERSION: z.enum(['TLSv1.2', 'TLSv1.3']).default('TLSv1.2'),
    /** Padrões das conexões de saída com TLS: CA confiável e identidade da API (mTLS), se o serviço não definir a sua. */
    TLS_CA_FILE: optional,
    TLS_CLIENT_CERT_FILE: optional,
    TLS_CLIENT_KEY_FILE: optional,
})

const commonSchema = z.object({
    /** Duração simulada do relatório de exemplo (ms). */
    REPORT_DURATION_MS: z.coerce.number().int().min(0).default(3000),
})

/** Chave AES-256 em base64 (openssl rand -base64 32). */
const aesKey = z.string().trim().refine(
    value => Buffer.from(value, 'base64').length === 32 && /^[A-Za-z0-9+/]+=*$/.test(value),
    'use 32 bytes em base64 (gere com: openssl rand -base64 32)',
)

const vaultSchema = z.object({
    /** Endereço do Vault (ou do Vault Agent, que já autentica: no Kubernetes, http://127.0.0.1:8100). */
    VAULT_ADDR: z.url().optional(),
    /** Token em arquivo (sink do Vault Agent). Sem ele, as chamadas vão sem token (o Agent em modo proxy injeta). */
    VAULT_TOKEN_FILE: optional,
    VAULT_NAMESPACE: optional,
    VAULT_TRANSIT_MOUNT: z.string().trim().min(1).default('transit'),
    VAULT_TRANSIT_KEY: z.string().trim().min(1).default('mfa'),
    ...tlsClientShape('VAULT'),
})

const secretsSchema = z.object({
    /** Com que frequência os arquivos de segredos e certificados são relidos (0 desliga a recarga automática). */
    SECRETS_RELOAD_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
})

const mfaSchema = z.object({
    /**
     * Onde ficam as chaves que cifram os segredos TOTP: local (MFA_ENCRYPTION_KEY) ou vault-transit (o Vault cifra e
     * decifra; a chave nunca sai dele).
     */
    MFA_CIPHER: z.enum(['local', 'vault-transit']).default('local'),
    /** Com MFA_CIPHER=local e REPOSITORY_DRIVER=mongo, obrigatória (sem ela, os segredos se perderiam ao reiniciar). */
    MFA_ENCRYPTION_KEY: aesKey.optional(),
    /** Chaves anteriores, separadas por vírgula: continuam decifrando durante a rotação. */
    MFA_ENCRYPTION_PREVIOUS_KEYS: z
        .string()
        .default('')
        .transform(value => value.split(',').map(key => key.trim()).filter(Boolean))
        .pipe(z.array(aesKey)),
    /** Papéis que só recebem escopos com MFA ativo e usado no login (ex.: admin). Vazio: MFA opcional para todos. */
    MFA_REQUIRED_ROLES: z
        .string()
        .default('')
        .transform(value => value.split(',').map(role => role.trim()).filter(Boolean))
        .pipe(z.array(z.enum(USER_ROLES))),
    /** Nome que aparece no aplicativo autenticador (padrão: APP_NAME). */
    MFA_ISSUER: optional,
    /** Tempo para digitar o código depois da senha. */
    MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
})

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

type ParsedEnv = z.infer<typeof repoSchema> &
    z.infer<typeof queueSchema> &
    z.infer<typeof timeseriesSchema> &
    z.infer<typeof eventBusSchema> &
    z.infer<typeof observabilitySchema> &
    z.infer<typeof serverSchema> &
    z.infer<typeof commonSchema> &
    z.infer<typeof mfaSchema> &
    z.infer<typeof vaultSchema> &
    z.infer<typeof secretsSchema> &
    z.infer<typeof authSchema>

export type Env = ParsedEnv & {
    /** TLS já resolvido: presente só nas conexões em que está ligado. */
    tls: TlsSettings;
    /** Variáveis lidas de arquivo (<VAR>_FILE): o caminho de cada uma, para a recarga quando o arquivo muda. */
    secretFiles: Partial<Record<SecretVar, string>>;
}

/**
 * Segredos que também podem vir de arquivo: <VAR>_FILE=/caminho. É assim que o Vault Agent (e os Secrets do
 * Kubernetes) entregam valores sem passá-los por variável de ambiente, e é o que permite trocá-los sem reiniciar.
 */
export const SECRET_VARS = [
    'MONGO_URI', 'MONGO_USERNAME', 'MONGO_PASSWORD',
    'REDIS_URL', 'REDIS_USERNAME', 'REDIS_PASSWORD',
    'RABBITMQ_URI', 'RABBITMQ_USERNAME', 'RABBITMQ_PASSWORD',
    'INFLUX_TOKEN',
    'ADMIN_PASSWORD',
    'MFA_ENCRYPTION_KEY', 'MFA_ENCRYPTION_PREVIOUS_KEYS',
] as const
export type SecretVar = (typeof SECRET_VARS)[number]

/** Lê o segredo do arquivo (sem a quebra de linha final que os templates costumam deixar). */
export function readSecretFile(path: string, name: string): string {
    try {
        return readFileSync(path, 'utf8').replace(/\r?\n$/, '')
    } catch (err) {
        throw new Error(`${name}_FILE: não foi possível ler ${path}: ${(err as Error).message}`, { cause: err })
    }
}

function resolveSecretFiles(source: Record<string, string | undefined>) {
    const values: Record<string, string> = {}
    const files: Partial<Record<SecretVar, string>> = {}
    for (const name of SECRET_VARS) {
        const path = source[`${name}_FILE`]?.trim()
        if (!path) continue
        if (source[name]) throw new Error(`Defina ${name} ou ${name}_FILE, não os dois`)
        values[name] = readSecretFile(path, name)
        files[name] = path
    }
    return { values, files }
}

export type TlsSettings = {
    server?: TlsServerConfig;
    mongo?: TlsClientConfig;
    redis?: TlsClientConfig;
    rabbitmq?: TlsClientConfig;
    influx?: TlsClientConfig;
    vault?: TlsClientConfig;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
    const secrets = resolveSecretFiles(source)
    const input = {
        REPOSITORY_DRIVER: 'memory',
        QUEUE_DRIVER: 'in-process',
        TIMESERIES_DRIVER: 'memory',
        EVENT_BUS_DRIVER: 'memory',
        ...source,
        ...secrets.values,
    }
    const parsed: ParsedEnv = {
        ...repoSchema.parse(input),
        ...queueSchema.parse(input),
        ...timeseriesSchema.parse(input),
        ...eventBusSchema.parse(input),
        ...observabilitySchema.parse(input),
        ...serverSchema.parse(input),
        ...commonSchema.parse(input),
        ...mfaSchema.parse(input),
        ...vaultSchema.parse(input),
        ...secretsSchema.parse(input),
        ...authSchema.parse(input),
    }
    const env: Env = { ...parsed, tls: resolveTls(parsed), secretFiles: secrets.files }
    if (env.QUEUE_DRIVER === 'redis' && env.REPOSITORY_DRIVER === 'memory') {
        throw new Error(
            'QUEUE_DRIVER=redis exige REPOSITORY_DRIVER=mongo (o estado dos jobs precisa ser compartilhado entre instâncias)',
        )
    }
    return env
}

/** Junta as variáveis de TLS de cada conexão (com os padrões TLS_*) e recusa combinações incoerentes. */
function resolveTls(env: ParsedEnv): TlsSettings {
    const errors: string[] = []
    const tls: TlsSettings = {}

    if (env.SERVER_TLS) {
        if (!env.SERVER_TLS_CERT_FILE || !env.SERVER_TLS_KEY_FILE) {
            errors.push('SERVER_TLS=true exige SERVER_TLS_CERT_FILE e SERVER_TLS_KEY_FILE')
        }
        if (env.SERVER_TLS_CLIENT_AUTH === 'require' && !env.SERVER_TLS_CA_FILE) {
            errors.push('SERVER_TLS_CLIENT_AUTH=require exige SERVER_TLS_CA_FILE (CA dos certificados de cliente)')
        }
        tls.server = {
            certFile: env.SERVER_TLS_CERT_FILE ?? '',
            keyFile: env.SERVER_TLS_KEY_FILE ?? '',
            caFile: env.SERVER_TLS_CA_FILE,
            clientAuth: env.SERVER_TLS_CLIENT_AUTH,
            minVersion: env.SERVER_TLS_MIN_VERSION,
        }
    } else if (env.SERVER_TLS_CERT_FILE || env.SERVER_TLS_KEY_FILE || env.SERVER_TLS_CLIENT_AUTH === 'require') {
        errors.push('SERVER_TLS_* definido, mas SERVER_TLS não é true: o servidor subiria em HTTP sem avisar')
    }

    const client = (prefix: string, values: object, label: string, scheme: TlsScheme) => {
        const get = (key: keyof typeof tlsClientFields) => (values as Record<string, unknown>)[`${prefix}_${key}`]
        const enabled = get('TLS') === true || scheme.secure
        if (!enabled) {
            const stray = (['TLS_CA_FILE', 'TLS_CERT_FILE', 'TLS_KEY_FILE', 'TLS_SERVERNAME'] as const).filter(key => get(key))
            if (stray.length > 0) {
                errors.push(`${stray.map(key => `${prefix}_${key}`).join(', ')} definido, mas o TLS do ${label} está `
                    + `desligado (use ${prefix}_TLS=true${scheme.hint ? ` e ${scheme.hint}` : ''})`)
            }
            return undefined
        }
        if (scheme.plain) errors.push(`${prefix}_TLS=true exige ${scheme.hint}`)
        const config: TlsClientConfig = {
            caFile: (get('TLS_CA_FILE') as string | undefined) ?? env.TLS_CA_FILE,
            certFile: (get('TLS_CERT_FILE') as string | undefined) ?? env.TLS_CLIENT_CERT_FILE,
            keyFile: (get('TLS_KEY_FILE') as string | undefined) ?? env.TLS_CLIENT_KEY_FILE,
            servername: get('TLS_SERVERNAME') as string | undefined,
            rejectUnauthorized: get('TLS_REJECT_UNAUTHORIZED') !== false,
        }
        if (Boolean(config.certFile) !== Boolean(config.keyFile)) {
            errors.push(`TLS do ${label}: defina o certificado e a chave de cliente juntos (${prefix}_TLS_CERT_FILE e `
                + `${prefix}_TLS_KEY_FILE, ou TLS_CLIENT_CERT_FILE e TLS_CLIENT_KEY_FILE)`)
        }
        return config
    }

    if (env.REPOSITORY_DRIVER === 'mongo') {
        // mongodb+srv:// liga TLS por padrão; na URI, tls=true (ou ssl=true) também
        const secure = env.MONGO_URI.startsWith('mongodb+srv://') || /[?&](tls|ssl)=true(&|$)/i.test(env.MONGO_URI)
        tls.mongo = client('MONGO', env, 'MongoDB', { secure, plain: false })
    }
    if (env.QUEUE_DRIVER === 'redis') {
        // o ioredis liga o TLS pela opção, mesmo com redis://; rediss:// é a forma explícita
        tls.redis = client('REDIS', env, 'Redis', { secure: env.REDIS_URL.startsWith('rediss://'), plain: false })
    }
    if (env.EVENT_BUS_DRIVER === 'rabbitmq') {
        const secure = env.RABBITMQ_URI.startsWith('amqps://')
        tls.rabbitmq = client('RABBITMQ', env, 'RabbitMQ', {
            secure, plain: !secure, hint: 'RABBITMQ_URI com amqps:// (porta padrão 5671)',
        })
    }
    if (env.TIMESERIES_DRIVER === 'influx') {
        const secure = env.INFLUX_URL.startsWith('https://')
        tls.influx = client('INFLUX', env, 'InfluxDB', { secure, plain: !secure, hint: 'INFLUX_URL com https://' })
    }

    if (env.VAULT_ADDR) {
        const secure = env.VAULT_ADDR.startsWith('https://')
        tls.vault = client('VAULT', env, 'Vault', { secure, plain: !secure, hint: 'VAULT_ADDR com https://' })
    }

    if (errors.length > 0) throw new Error(`Configuração de TLS inválida:\n  - ${errors.join('\n  - ')}`)
    return tls
}

/** secure: a URL já pede TLS; plain: a URL é explicitamente sem TLS (e o protocolo não permite ligar só pela opção). */
type TlsScheme = { secure: boolean; plain: boolean; hint?: string }

/**
 * Exigências para rodar a API (não para ferramentas como npm run db:migrate, que só usam parte da configuração):
 * chamada na montagem do container.
 */
export function assertRuntimeEnv(env: Env): void {
    if (env.MFA_CIPHER === 'local' && env.REPOSITORY_DRIVER === 'mongo' && !env.MFA_ENCRYPTION_KEY) {
        throw new Error('REPOSITORY_DRIVER=mongo exige MFA_ENCRYPTION_KEY (cifra os segredos do MFA no banco) '
            + 'ou MFA_CIPHER=vault-transit. Gere a chave com: openssl rand -base64 32')
    }
    if (env.MFA_CIPHER === 'vault-transit' && !env.VAULT_ADDR) {
        throw new Error('MFA_CIPHER=vault-transit exige VAULT_ADDR')
    }
}
