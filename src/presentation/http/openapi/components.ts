import { DEVICE_STATUSES } from '../../../domain/model/device.ts'
import { JOB_STATUSES } from '../../../domain/model/job.ts'
import { PASSAGE_DIRECTIONS } from '../../../domain/model/passage.ts'
import { AUTH_METHODS, SESSION_REVOKE_REASONS } from '../../../domain/model/session.ts'
import { USER_ROLES } from '../../../domain/model/user.ts'
import { S, type JsonSchema } from './json.schema.ts'

const timestamps = { createdAt: S.dateTime(), updatedAt: S.dateTime() }

/** Formato das respostas. Nomes iguais aos campos que a API devolve (JSON público dos models). */
export const schemas: Record<string, JsonSchema> = {
    Error: S.object({
        code: S.enum([
            'VALIDATION', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'BAD_REQUEST', 'UNAVAILABLE', 'INTERNAL',
        ]),
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
        mfa_enrollment_required: {
            type: 'boolean',
            description: 'Só aparece (true) quando o papel exige MFA e o usuário ainda não ativou: o token não tem '
                + 'escopos e só serve para configurar o MFA. Depois de ativar, renove em POST /auth/refresh.',
        },
    }, ['access_token', 'token_type', 'expires_in', 'refresh_token', 'refresh_expires_in']),

    MfaChallenge: S.object({
        mfa_required: { type: 'boolean', const: true },
        mfa_token: S.string({ description: 'Credencial da segunda etapa (POST /auth/mfa/verify). Opaca e de uso único.' }),
        mfa_methods: S.array(S.enum(['totp', 'recovery_code'])),
        expires_in: S.int({ description: 'Segundos para concluir a segunda etapa.' }),
    }, ['mfa_required', 'mfa_token', 'mfa_methods', 'expires_in'],
    'O usuário tem MFA: a senha confere, falta o código do aplicativo (ou um de recuperação).'),

    MfaStatus: S.object({
        enabled: { type: 'boolean' },
        enabled_at: S.dateTime(),
        recovery_codes_remaining: S.int({ description: 'Códigos de recuperação ainda não usados.' }),
        required: { type: 'boolean', description: 'O papel do usuário exige MFA (MFA_REQUIRED_ROLES).' },
    }, ['enabled', 'recovery_codes_remaining', 'required']),

    MfaSetup: S.object({
        secret: S.string({ description: 'Segredo em base32, para digitar no aplicativo.', example: 'JBSWY3DPEHPK3PXP' }),
        otpauth_url: S.string({
            description: 'Mostre como QR code (Google Authenticator, Microsoft Authenticator, 1Password, Authy...).',
            example: 'otpauth://totp/api:admin%40exemplo.com?secret=JBSWY3DPEHPK3PXP&issuer=api',
        }),
        expires_in: S.int({ description: 'Segundos para confirmar em POST /auth/mfa/enable.' }),
    }),

    RecoveryCodes: S.object({
        recovery_codes: S.array(S.string({ example: 'K7QM-9XRT-4HWC-2NPA' })),
    }, ['recovery_codes'], 'Mostrados uma única vez: guarde fora do celular. Cada código vale um login.'),

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
        amr: S.array(S.enum(AUTH_METHODS, 'Como o login foi feito: pwd (senha), otp (aplicativo), mfa (segundo fator).')),
        current: { type: 'boolean', description: 'Sessão do token usado nesta requisição.' },
        ...timestamps,
    }, ['id', 'userId', 'expiresAt', 'amr', 'current', 'createdAt', 'updatedAt']),

    Revoked: S.object({ revoked: S.int({ description: 'Quantidade de sessões encerradas.' }) }),

    User: S.object({
        id: S.uuid(),
        name: S.string(),
        email: S.string({ format: 'email' }),
        role: S.enum(USER_ROLES),
        mfaEnabled: { type: 'boolean', description: 'Autenticação multifator ativa.' },
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

    Health: S.object({ status: S.enum(['ok']), uptime_seconds: S.int() }),

    Readiness: S.object({
        status: S.enum(['ready', 'not_ready']),
        checks: {
            type: 'object',
            description: 'Uma entrada por dependência (mongodb, redis, influxdb, rabbitmq, outbox), conforme os drivers em uso.',
            additionalProperties: {
                type: 'object',
                properties: {
                    status: S.enum(['up', 'down']),
                    critical: { type: 'boolean', description: 'Se estiver down, a instância não está pronta.' },
                    latency_ms: S.int(),
                    details: { type: 'object' },
                },
                required: ['status', 'critical', 'latency_ms'],
            },
        },
    }),
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
        'O token não tem o escopo exigido (ou o papel exige MFA e o usuário ainda não ativou).',
        { code: 'FORBIDDEN', message: 'Escopo necessário: jobs:create' },
    ),
    NotFound: errorResponse(
        'Não existe ou não pertence a quem pediu (a API não revela ids de outros usuários).',
        { code: 'NOT_FOUND', message: 'Não encontrado' },
    ),
    Conflict: errorResponse('Conflito com um registro existente.', { code: 'CONFLICT', message: 'E-mail já cadastrado' }),
    ServiceUnavailable: {
        ...errorResponse(
            'Uma dependência (banco, fila ou barramento) está fora do ar. Tente de novo após o tempo de Retry-After.',
            { code: 'UNAVAILABLE', message: 'Serviço temporariamente indisponível. Tente novamente em instantes' },
        ),
        headers: {
            'X-Request-ID': { $ref: '#/components/headers/XRequestId' },
            'Retry-After': { description: 'Segundos até tentar de novo.', schema: S.int() },
        },
    },
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
