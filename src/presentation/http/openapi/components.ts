import { DEVICE_STATUSES } from '../../../domain/model/device.ts'
import { JOB_STATUSES } from '../../../domain/model/job.ts'
import { PASSAGE_DIRECTIONS } from '../../../domain/model/passage.ts'
import { SESSION_REVOKE_REASONS } from '../../../domain/model/session.ts'
import { USER_ROLES } from '../../../domain/model/user.ts'
import { S, type JsonSchema } from './json.schema.ts'

const timestamps = { createdAt: S.dateTime(), updatedAt: S.dateTime() }

/** Formato das respostas. Nomes iguais aos campos que a API devolve (JSON público dos models). */
export const schemas: Record<string, JsonSchema> = {
    Error: S.object({
        code: S.enum(['VALIDATION', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'BAD_REQUEST', 'INTERNAL']),
        message: S.string(),
        issues: S.array({
            type: 'object',
            description: 'Um problema por campo (formato do zod): path, message e code.',
            properties: { path: S.array({ type: ['string', 'integer'] }), message: S.string(), code: S.string() },
            required: ['path', 'message'],
        }),
    }, ['code', 'message'], 'Erro. "issues" só vem nos erros de validação (400).'),

    TokenPair: S.object({
        access_token: S.string({ description: 'JWT RS256. Envie em Authorization: Bearer <token>.' }),
        token_type: S.enum(['Bearer']),
        expires_in: S.int({ description: 'Segundos até o access token expirar.' }),
        refresh_token: S.string({ description: 'Opaco e de uso único: cada refresh devolve um novo.' }),
        refresh_expires_in: S.int({ description: 'Segundos até a sessão expirar (validade absoluta).' }),
    }),

    Jwks: S.object({
        keys: S.array({ type: 'object', description: 'Chave pública (JWK) usada para validar os tokens.' }),
    }),

    Session: S.object({
        id: S.uuid(),
        userId: S.uuid(),
        expiresAt: S.dateTime(),
        lastUsedAt: S.dateTime('Último refresh.'),
        revokedAt: S.dateTime(),
        revokedReason: S.enum(SESSION_REVOKE_REASONS),
        userAgent: S.string(),
        ip: S.string(),
        current: { type: 'boolean', description: 'Sessão do token usado nesta requisição.' },
        ...timestamps,
    }, ['id', 'userId', 'expiresAt', 'current', 'createdAt', 'updatedAt']),

    Revoked: S.object({ revoked: S.int({ description: 'Quantidade de sessões encerradas.' }) }),

    User: S.object({
        id: S.uuid(),
        name: S.string(),
        email: S.string({ format: 'email' }),
        role: S.enum(USER_ROLES),
        ...timestamps,
    }),

    Job: S.object({
        id: S.uuid(),
        type: S.string({ example: 'report.generate' }),
        payload: { description: 'Entrada do job (formato depende do tipo).' },
        managerId: S.uuid('Gestor que criou o job (vem do token).'),
        clientId: S.uuid(),
        status: S.enum(JOB_STATUSES),
        result: { description: 'Resultado (status succeeded).' },
        error: S.string({ description: 'Motivo da falha (status failed).' }),
        startedAt: S.dateTime(),
        finishedAt: S.dateTime(),
        ...timestamps,
    }, ['id', 'type', 'managerId', 'clientId', 'status', 'createdAt', 'updatedAt']),

    PairingCode: S.object({
        code: S.string({ example: 'K7QM-9XRT', description: 'Digitado na ESP32. Uso único.' }),
        expires_at: S.dateTime(),
        expires_in: S.int({ description: 'Segundos até expirar.' }),
    }),

    DeviceClaim: S.object({
        device_id: S.uuid(),
        client_id: S.uuid('Vai no campo clientId de cada envio.'),
        access_token: S.string({ description: 'Token do dispositivo: só vale para POST /devices/{deviceId}/passages.' }),
        token_type: S.enum(['Bearer']),
        expires_in: S.int(),
    }),

    Device: S.object({
        id: S.uuid(),
        clientId: S.uuid(),
        name: S.string(),
        hardwareId: S.string({ description: 'MAC da ESP32.', example: '24:6F:28:AB:CD:EF' }),
        firmware: S.string(),
        status: S.enum(DEVICE_STATUSES),
        revokedAt: S.dateTime(),
        lastSeenAt: S.dateTime('Último envio de dados.'),
        ...timestamps,
    }, ['id', 'clientId', 'name', 'status', 'createdAt', 'updatedAt']),

    Accepted: S.object({ accepted: S.int({ description: 'Eventos novos gravados (repetidos são ignorados).' }) }),

    Passage: S.object({
        eventId: S.uuid(),
        occurredAt: S.dateTime('Hora da passagem, pelo relógio da ESP32.'),
        direction: S.enum(PASSAGE_DIRECTIONS),
        sequence: S.int(),
        deviceId: S.uuid(),
        clientId: S.uuid(),
        receivedAt: S.dateTime('Hora em que a API recebeu.'),
    }, ['eventId', 'occurredAt', 'direction', 'deviceId', 'clientId', 'receivedAt']),

    PassageSummary: S.object({
        window: S.string({ example: '1h' }),
        windows: S.array(S.object({
            start: S.dateTime('Início da janela.'),
            in: S.int(),
            out: S.int(),
            unknown: S.int(),
        })),
    }),

    Health: S.object({ status: S.enum(['ok']) }),
}

const errorResponse = (description: string, example: { code: string; message: string }) => ({
    description,
    headers: { 'X-Request-ID': { $ref: '#/components/headers/XRequestId' } },
    content: { 'application/json': { schema: S.ref('Error'), example } },
})

export const responses = {
    BadRequest: errorResponse('Dados ou parâmetros inválidos.', { code: 'VALIDATION', message: 'Dados inválidos' }),
    Unauthorized: errorResponse(
        'Token ausente, inválido, expirado ou de sessão encerrada. Pelo Kong, a mensagem vem do gateway.',
        { code: 'UNAUTHORIZED', message: 'Sessão encerrada. Faça login novamente' },
    ),
    Forbidden: errorResponse(
        'O token não tem o escopo exigido.',
        { code: 'FORBIDDEN', message: 'Escopo necessário: jobs:create' },
    ),
    NotFound: errorResponse(
        'Não existe ou não pertence a quem pediu (a API não revela ids de outros usuários).',
        { code: 'NOT_FOUND', message: 'Não encontrado' },
    ),
    Conflict: errorResponse('Conflito com um registro existente.', { code: 'CONFLICT', message: 'E-mail já cadastrado' }),
    TooManyRequests: {
        description: 'Limite de requisições do Kong excedido (só pelo gateway). Veja os headers RateLimit-*.',
    },
}

export const headers = {
    XRequestId: {
        description: 'Id da requisição (gerado pelo Kong ou pela API). Aparece nos logs e na auditoria.',
        schema: S.string(),
    },
    XTotalCount: {
        description: 'Total de itens que atendem aos filtros (para paginação).',
        schema: S.int(),
    },
}
