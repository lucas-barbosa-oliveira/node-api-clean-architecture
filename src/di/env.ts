import { z } from 'zod'

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
        JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
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
    z.infer<typeof commonSchema> &
    z.infer<typeof authSchema>

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
    const input = { REPOSITORY_DRIVER: 'memory', QUEUE_DRIVER: 'in-process', ...source }
    const env: Env = {
        ...repoSchema.parse(input),
        ...queueSchema.parse(input),
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
