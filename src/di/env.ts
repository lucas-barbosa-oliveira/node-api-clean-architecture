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

export type Env = z.infer<typeof repoSchema> & z.infer<typeof queueSchema> & z.infer<typeof commonSchema>

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
    const input = { REPOSITORY_DRIVER: 'memory', QUEUE_DRIVER: 'in-process', ...source }
    const env: Env = {
        ...repoSchema.parse(input),
        ...queueSchema.parse(input),
        ...commonSchema.parse(input),
    }
    if (env.QUEUE_DRIVER === 'redis' && env.REPOSITORY_DRIVER === 'memory') {
        throw new Error(
            'QUEUE_DRIVER=redis exige REPOSITORY_DRIVER=mongo (o estado dos jobs precisa ser compartilhado entre instâncias)',
        )
    }
    return env
}
