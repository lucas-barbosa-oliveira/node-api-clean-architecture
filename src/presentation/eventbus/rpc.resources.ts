import type { RpcResource } from '../../application/port/event.bus.ts'
import { JOB_QUERY_SCHEMA } from '../../application/query/job.query.schema.ts'
import { USER_QUERY_SCHEMA } from '../../application/query/user.query.schema.ts'
import type { JobService } from '../../application/service/job.service.ts'
import type { UserService } from '../../application/service/user.service.ts'
import type { Actor } from '../../domain/auth/actor.ts'
import { SCOPES } from '../../domain/auth/scopes.ts'
import { ValidationError } from '../../domain/error/index.ts'
import { parseQueryString, selectFields } from '../http/query/list.query.parser.ts'

/**
 * Quem chama por RPC é outro microsserviço da rede interna (não um usuário): o acesso é de leitura ampla.
 * O barramento não deve ser exposto fora da rede dos serviços.
 */
const SERVICE_ACTOR: Actor = {
    userId: 'service',
    role: 'admin',
    scopes: [SCOPES.usersReadAny, SCOPES.jobsReadAny],
}

/**
 * Recursos que este serviço oferece por RPC (o equivalente às rotas HTTP para outros microsserviços).
 * Outro serviço chama: executeResource('<APP_NAME>', 'users.find', '?role=client&limit=10').
 * As consultas aceitam a mesma query string das rotas HTTP, validada pelo mesmo schema.
 */
export function rpcResources(deps: { userService: UserService; jobService: JobService }): RpcResource[] {
    return [
        {
            name: 'users.find',
            handle: async query => {
                const parsed = parseQueryString(asQuery(query), USER_QUERY_SCHEMA)
                return toJson(selectFields((await deps.userService.list(parsed)).items, parsed))
            },
        },
        {
            name: 'users.findone',
            handle: async id => toJson(await deps.userService.getById(SERVICE_ACTOR, asId(id))),
        },
        {
            name: 'jobs.find',
            handle: async query => {
                const parsed = parseQueryString(asQuery(query), JOB_QUERY_SCHEMA)
                return toJson(selectFields((await deps.jobService.list(SERVICE_ACTOR, parsed)).items, parsed))
            },
        },
    ]
}

function asQuery(value: unknown): string {
    if (value === undefined || value === null) return ''
    if (typeof value !== 'string') throw new ValidationError('A consulta deve ser uma query string, ex.: "?limit=10"')
    return value
}

function asId(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) throw new ValidationError('Informe o id')
    return value
}

/** Mesmo JSON das respostas HTTP (sem campos internos como passwordHash). */
function toJson(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value))
}
