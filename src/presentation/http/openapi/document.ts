import { z } from 'zod'
import { DEVICE_QUERY_SCHEMA } from '../../../application/query/device.query.schema.ts'
import { JOB_QUERY_SCHEMA } from '../../../application/query/job.query.schema.ts'
import { PASSAGE_QUERY_SCHEMA } from '../../../application/query/passage.query.schema.ts'
import { USER_QUERY_SCHEMA } from '../../../application/query/user.query.schema.ts'
import { refreshSchema } from '../../../application/service/auth.service.ts'
import { DEVICE_SCOPES, ROLE_SCOPES, SCOPES, type Scope } from '../../../domain/auth/scopes.ts'
import { claimDeviceSchema, passageBatchSchema } from '../../../domain/validator/device.validator.ts'
import { jobPayloadSchemas } from '../../../domain/validator/job.validator.ts'
import { mfaCodeSchema, mfaVerifySchema, totpCodeSchema } from '../../../domain/validator/mfa.validator.ts'
import { createUserSchema, loginSchema } from '../../../domain/validator/user.validator.ts'
import { headers, responses, schemas } from './components.ts'
import { fromZod, S, type JsonSchema } from './json.schema.ts'
import { listParameters } from './list.parameters.ts'

type ErrorName = keyof typeof responses
type Access = Scope | 'public' | 'authenticated'

type Operation = {
    tag: string;
    summary: string;
    description?: string;
    access: Access;
    parameters?: object[];
    body?: { schema: JsonSchema; example?: unknown; description?: string };
    /** status -> resposta de sucesso */
    ok: Record<number, { description: string; schema?: JsonSchema; headers?: Record<string, object>; example?: unknown }>;
    errors?: ErrorName[];
    /** Não acessa banco nem fila (nunca responde 503 por dependência fora do ar). */
    noDependencies?: boolean;
}

const ROLE_LABEL: Record<string, string> = { admin: 'administrador', manager: 'gestor', client: 'cliente' }

/** Quem pode chamar, calculado a partir dos escopos de cada papel (não fica desatualizado). */
function accessText(access: Access): string {
    if (access === 'public') return '**Acesso:** público (sem token).'
    if (access === 'authenticated') return '**Acesso:** qualquer usuário autenticado.'
    const roles = Object.entries(ROLE_SCOPES).filter(([, scopes]) => scopes.includes(access)).map(([role]) => ROLE_LABEL[role])
    if (DEVICE_SCOPES.includes(access)) roles.push('dispositivo (token recebido no pareamento)')
    return `**Escopo:** \`${access}\` — ${roles.join(', ')}.`
}

function operation(op: Operation): object {
    const errors = new Set<ErrorName>(op.errors ?? [])
    if (op.access !== 'public') {
        errors.add('Unauthorized')
        if (op.access !== 'authenticated') errors.add('Forbidden')
    }
    if (op.body) errors.add('BadRequest')
    errors.add('TooManyRequests')
    if (!op.noDependencies) errors.add('ServiceUnavailable')

    const status: Record<ErrorName, number> = {
        BadRequest: 400, Unauthorized: 401, Forbidden: 403, NotFound: 404, Conflict: 409,
        TooManyRequests: 429, ServiceUnavailable: 503,
    }
    const okResponses = Object.fromEntries(Object.entries(op.ok).map(([code, res]) => [code, {
        description: res.description,
        headers: { 'X-Request-ID': { $ref: '#/components/headers/XRequestId' }, ...res.headers },
        ...(res.schema && {
            content: { 'application/json': { schema: res.schema, ...(res.example !== undefined && { example: res.example }) } },
        }),
    }]))
    const errorResponses = Object.fromEntries([...errors]
        .sort((a, b) => status[a] - status[b])
        .map(name => [status[name], { $ref: `#/components/responses/${name}` }]))

    return {
        tags: [op.tag],
        summary: op.summary,
        description: [op.description, accessText(op.access)].filter(Boolean).join('\n\n'),
        ...(op.access === 'public' ? { security: [] } : {}),
        ...(op.parameters && { parameters: op.parameters }),
        ...(op.body && {
            requestBody: {
                required: true,
                ...(op.body.description && { description: op.body.description }),
                content: {
                    'application/json': {
                        schema: op.body.schema,
                        ...(op.body.example !== undefined && { example: op.body.example }),
                    },
                },
            },
        }),
        responses: { ...okResponses, ...errorResponses },
    }
}

const pathId = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: S.uuid() })
const page = (item: string) => ({
    description: 'Página de resultados (array). Com ?fields=, cada item traz só os campos pedidos.',
    schema: S.array(S.ref(item)),
    headers: { 'X-Total-Count': { $ref: '#/components/headers/XTotalCount' } },
})

const reportBody = z.object({
    clientId: z.uuid().describe('Cliente para quem o relatório é gerado.'),
    ...(jobPayloadSchemas['report.generate'] as z.ZodObject).shape,
})

/**
 * Documento OpenAPI 3.1 da API, montado em código:
 *  - corpos de requisição vêm dos mesmos schemas zod da validação;
 *  - parâmetros de listagem vêm da whitelist de cada recurso (QuerySchema);
 *  - quem pode chamar cada rota vem de ROLE_SCOPES.
 * Testes conferem que toda rota do Express está aqui e que as respostas seguem os schemas.
 */
export function buildOpenApiDocument(info: { title: string; version: string }) {
    const paths = {
        '/health': {
            get: operation({
                tag: 'Sistema',
                summary: 'Processo no ar (alias de /health/live)',
                access: 'public',
                noDependencies: true,
                ok: { 200: { description: 'Processo no ar.', schema: S.ref('Health') } },
            }),
        },
        '/health/live': {
            get: operation({
                tag: 'Sistema',
                summary: 'Liveness: o processo está de pé',
                description: 'Não consulta dependências. Usada pelo HEALTHCHECK do Docker: se falhar, o container é reiniciado. '
                    + 'Não aparece na auditoria.',
                access: 'public',
                noDependencies: true,
                ok: { 200: { description: 'Processo no ar.', schema: S.ref('Health') } },
            }),
        },
        '/health/ready': {
            get: operation({
                tag: 'Sistema',
                summary: 'Readiness: a instância consegue atender',
                description: 'Verifica cada dependência. Responde 503 se alguma crítica (MongoDB, Redis) estiver fora do ar '
                    + 'ou se a instância estiver encerrando: o balanceador deixa de enviar tráfego, sem reiniciar. '
                    + 'Dependências não críticas (InfluxDB, RabbitMQ, outbox) aparecem no relatório sem tirar a instância do ar.',
                access: 'public',
                noDependencies: true,
                ok: {
                    200: { description: 'Pronta.', schema: S.ref('Readiness') },
                    503: { description: 'Não está pronta (ver checks).', schema: S.ref('Readiness') },
                },
            }),
        },
        '/.well-known/jwks.json': {
            get: operation({
                tag: 'Autenticação',
                summary: 'Chave pública dos tokens (JWKS)',
                noDependencies: true,
                description: 'Outros serviços validam os JWTs com esta chave, sem chamar a API.',
                access: 'public',
                ok: { 200: { description: 'Chaves públicas.', schema: S.ref('Jwks') } },
            }),
        },
        '/auth/login': {
            post: operation({
                tag: 'Autenticação',
                summary: 'Login',
                description: 'Abre uma sessão e devolve o par de tokens. **Na documentação, o token é aplicado automaticamente '
                    + 'em "Authorize"** para as próximas chamadas. Limite no Kong: 10/min por IP.\n\n'
                    + '**Com MFA ativo**, a resposta não traz tokens: traz `mfa_required: true` e um `mfa_token`, que vai '
                    + 'com o código do aplicativo em POST /auth/mfa/verify.',
                access: 'public',
                body: { schema: fromZod(loginSchema), example: { email: 'admin@exemplo.com', password: 'admin-local-123' } },
                ok: {
                    200: {
                        description: 'Tokens, ou o desafio de MFA (segunda etapa).',
                        schema: { oneOf: [S.ref('TokenPair'), S.ref('MfaChallenge')] },
                    },
                },
                errors: ['Unauthorized'],
            }),
        },
        '/auth/mfa/verify': {
            post: operation({
                tag: 'Autenticação',
                summary: 'Login com MFA: segunda etapa',
                description: 'Troca o mfa_token do login e o código de 6 dígitos do aplicativo (ou um código de recuperação, '
                    + 'que deixa de valer) pelo par de tokens. Cada mfa_token aceita 5 tentativas e vale por poucos minutos; '
                    + 'depois, só com novo login. Cada código TOTP vale uma vez. Limite no Kong: 10/min por IP.',
                access: 'public',
                body: { schema: fromZod(mfaVerifySchema), example: { mfa_token: '<mfa_token do login>', code: '123456' } },
                ok: { 200: { description: 'Tokens.', schema: S.ref('TokenPair') } },
                errors: ['Unauthorized'],
            }),
        },
        '/auth/mfa': {
            get: operation({
                tag: 'MFA',
                summary: 'Situação do MFA do usuário',
                access: 'authenticated',
                ok: { 200: { description: 'Situação.', schema: S.ref('MfaStatus') } },
            }),
        },
        '/auth/mfa/setup': {
            post: operation({
                tag: 'MFA',
                summary: 'Configurar o MFA (passo 1)',
                description: 'Gera o segredo TOTP, ainda inativo. Mostre o `otpauth_url` como QR code e confirme com um '
                    + 'código em POST /auth/mfa/enable em até 10 minutos. Chamar de novo troca o segredo.',
                access: 'authenticated',
                ok: { 200: { description: 'Segredo para o aplicativo.', schema: S.ref('MfaSetup') } },
                errors: ['Conflict'],
            }),
        },
        '/auth/mfa/enable': {
            post: operation({
                tag: 'MFA',
                summary: 'Ativar o MFA (passo 2)',
                description: 'Confirma com o código atual do aplicativo e devolve os códigos de recuperação (só agora). '
                    + 'A sessão atual passa a valer como multifator e as outras sessões do usuário são encerradas. '
                    + 'Quem estava com o token restrito (papel que exige MFA) renova em POST /auth/refresh.',
                access: 'authenticated',
                body: { schema: fromZod(totpCodeSchema), example: { code: '123456' } },
                ok: { 200: { description: 'MFA ativo.', schema: S.ref('RecoveryCodes') } },
                errors: ['Conflict'],
            }),
        },
        '/auth/mfa/disable': {
            post: operation({
                tag: 'MFA',
                summary: 'Desativar o MFA',
                description: 'Exige um código do aplicativo ou de recuperação: o token sozinho não basta.',
                access: 'authenticated',
                body: { schema: fromZod(mfaCodeSchema), example: { code: '123456' } },
                ok: { 204: { description: 'MFA desativado.' } },
                errors: ['Conflict'],
            }),
        },
        '/auth/mfa/recovery-codes': {
            post: operation({
                tag: 'MFA',
                summary: 'Gerar novos códigos de recuperação',
                description: 'Os anteriores deixam de valer. Exige o código do aplicativo.',
                access: 'authenticated',
                body: { schema: fromZod(totpCodeSchema), example: { code: '123456' } },
                ok: { 200: { description: 'Códigos novos.', schema: S.ref('RecoveryCodes') } },
                errors: ['Conflict'],
            }),
        },
        '/users/{id}/mfa': {
            delete: operation({
                tag: 'MFA',
                summary: 'Redefinir o MFA de um usuário',
                description: 'Para quem perdeu o celular e os códigos de recuperação: desativa o MFA e encerra as sessões '
                    + 'do usuário, que entra só com a senha e configura de novo.',
                access: SCOPES.mfaResetAny,
                parameters: [pathId('id', 'Id do usuário.')],
                ok: { 204: { description: 'MFA redefinido.' } },
                errors: ['NotFound', 'Conflict'],
            }),
        },
        '/auth/refresh': {
            post: operation({
                tag: 'Autenticação',
                summary: 'Renovar os tokens',
                description: 'Troca o refresh token por um par novo (rotação). Reapresentar um refresh token já usado '
                    + 'revoga a sessão inteira (indica vazamento).',
                access: 'public',
                body: { schema: fromZod(refreshSchema) },
                ok: { 200: { description: 'Tokens novos.', schema: S.ref('TokenPair') } },
                errors: ['Unauthorized'],
            }),
        },
        '/auth/logout': {
            post: operation({
                tag: 'Sessões',
                summary: 'Encerrar a sessão atual',
                description: 'O access token deixa de valer na hora.',
                access: 'authenticated',
                ok: { 204: { description: 'Sessão encerrada.' } },
            }),
        },
        '/auth/logout-all': {
            post: operation({
                tag: 'Sessões',
                summary: 'Encerrar todas as sessões do usuário',
                access: 'authenticated',
                ok: { 200: { description: 'Sessões encerradas.', schema: S.ref('Revoked') } },
            }),
        },
        '/auth/sessions': {
            get: operation({
                tag: 'Sessões',
                summary: 'Listar as sessões ativas do usuário',
                access: 'authenticated',
                ok: { 200: { description: 'Sessões ativas.', schema: S.array(S.ref('Session')) } },
            }),
        },
        '/auth/sessions/{id}': {
            delete: operation({
                tag: 'Sessões',
                summary: 'Encerrar uma sessão',
                description: 'O usuário encerra uma sessão dele; com sessions:revoke:any (administrador), qualquer uma.',
                access: 'authenticated',
                parameters: [pathId('id', 'Id da sessão.')],
                ok: { 204: { description: 'Sessão encerrada.' } },
                errors: ['NotFound'],
            }),
        },
        '/users/{id}/sessions': {
            delete: operation({
                tag: 'Sessões',
                summary: 'Encerrar todas as sessões de um usuário',
                description: 'Para conta comprometida.',
                access: SCOPES.sessionsRevokeAny,
                parameters: [pathId('id', 'Id do usuário.')],
                ok: { 200: { description: 'Sessões encerradas.', schema: S.ref('Revoked') } },
                errors: ['NotFound'],
            }),
        },
        '/users': {
            post: operation({
                tag: 'Usuários',
                summary: 'Cadastrar gestor ou cliente',
                access: SCOPES.usersCreate,
                body: {
                    schema: fromZod(createUserSchema),
                    example: {
                        name: 'Cliente Exemplo',
                        email: 'cliente@exemplo.com',
                        password: 'senha-forte-123',
                        role: 'client',
                    },
                },
                ok: { 201: { description: 'Usuário criado.', schema: S.ref('User') } },
                errors: ['Conflict'],
            }),
            get: operation({
                tag: 'Usuários',
                summary: 'Listar usuários',
                access: SCOPES.usersReadAny,
                parameters: listParameters(USER_QUERY_SCHEMA),
                ok: { 200: page('User') },
                errors: ['BadRequest'],
            }),
        },
        '/users/me': {
            get: operation({
                tag: 'Usuários',
                summary: 'Usuário do token',
                access: SCOPES.usersRead,
                ok: { 200: { description: 'Cadastro.', schema: S.ref('User') } },
            }),
        },
        '/users/{id}': {
            get: operation({
                tag: 'Usuários',
                summary: 'Buscar usuário',
                description: 'Sem users:read:any, só o próprio cadastro (outros ids respondem 404).',
                access: SCOPES.usersRead,
                parameters: [pathId('id', 'Id do usuário.')],
                ok: { 200: { description: 'Cadastro.', schema: S.ref('User') } },
                errors: ['NotFound'],
            }),
        },
        '/clients': {
            get: operation({
                tag: 'Usuários',
                summary: 'Listar clientes',
                description: 'Clientes disponíveis para associar a um job.',
                access: SCOPES.clientsRead,
                parameters: listParameters(USER_QUERY_SCHEMA),
                ok: { 200: page('User') },
                errors: ['BadRequest'],
            }),
        },
        '/reports': {
            post: operation({
                tag: 'Jobs',
                summary: 'Pedir um relatório (assíncrono)',
                description: 'Responde 202 na hora; o relatório é gerado em segundo plano. '
                    + 'Acompanhe pelo Location (GET /jobs/{id}) '
                    + 'até o status ser succeeded ou failed.',
                access: SCOPES.jobsCreate,
                body: {
                    schema: fromZod(reportBody),
                    example: { clientId: '00000000-0000-4000-8000-000000000000', month: '2026-10' },
                },
                ok: {
                    202: {
                        description: 'Job criado (status pending).',
                        schema: S.ref('Job'),
                        headers: { Location: { description: 'URL do job: /jobs/{id}.', schema: S.string() } },
                    },
                },
            }),
        },
        '/jobs': {
            get: operation({
                tag: 'Jobs',
                summary: 'Listar jobs',
                description: 'Gestor vê os jobs que criou; cliente, os associados a ele; administrador, todos.',
                access: SCOPES.jobsRead,
                parameters: listParameters(JOB_QUERY_SCHEMA),
                ok: { 200: page('Job') },
                errors: ['BadRequest'],
            }),
        },
        '/jobs/{id}': {
            get: operation({
                tag: 'Jobs',
                summary: 'Consultar job',
                access: SCOPES.jobsRead,
                parameters: [pathId('id', 'Id do job.')],
                ok: { 200: { description: 'Job.', schema: S.ref('Job') } },
                errors: ['NotFound'],
            }),
        },
        '/clients/{clientId}/pairing-codes': {
            post: operation({
                tag: 'Dispositivos',
                summary: 'Gerar código de pareamento',
                description: 'O cliente gera para si (o administrador, para qualquer cliente). O código é digitado na ESP32, '
                    + 'expira em PAIRING_CODE_TTL_SECONDS e vale uma única vez.',
                access: SCOPES.devicesManage,
                parameters: [pathId('clientId', 'Id do cliente.')],
                ok: { 201: { description: 'Código gerado.', schema: S.ref('PairingCode') } },
                errors: ['NotFound'],
            }),
        },
        '/devices/claim': {
            post: operation({
                tag: 'Dispositivos',
                summary: 'Parear dispositivo (chamado pela ESP32)',
                description: 'Troca o código pelo id do cliente e pelo token do dispositivo. '
                    + 'Código inválido, expirado ou já usado: 401. '
                    + 'Limite no Kong: 10/min por IP. **Na documentação, o token do dispositivo é aplicado em "Authorize"**.',
                access: 'public',
                body: {
                    schema: fromZod(claimDeviceSchema),
                    example: { code: 'K7QM-9XRT', name: 'Porta da sala', hardwareId: '24:6F:28:AB:CD:EF', firmware: '1.0.0' },
                },
                ok: { 201: { description: 'Dispositivo pareado.', schema: S.ref('DeviceClaim') } },
                errors: ['Unauthorized'],
            }),
        },
        '/devices': {
            get: operation({
                tag: 'Dispositivos',
                summary: 'Listar dispositivos',
                description: 'O cliente vê os próprios; o administrador, todos.',
                access: SCOPES.devicesRead,
                parameters: listParameters(DEVICE_QUERY_SCHEMA),
                ok: { 200: page('Device') },
                errors: ['BadRequest'],
            }),
        },
        '/devices/{id}': {
            delete: operation({
                tag: 'Dispositivos',
                summary: 'Revogar dispositivo',
                description: 'O token do dispositivo deixa de valer na hora.',
                access: SCOPES.devicesManage,
                parameters: [pathId('id', 'Id do dispositivo.')],
                ok: { 204: { description: 'Dispositivo revogado.' } },
                errors: ['NotFound'],
            }),
        },
        '/devices/{deviceId}/passages': {
            post: operation({
                tag: 'Passagens',
                summary: 'Enviar lote de passagens (chamado pela ESP32)',
                description: 'Exige o token do dispositivo, e o clientId do corpo precisa ser o do pareamento (senão 403). '
                    + 'Reenviar um eventId não duplica a contagem. Limite no Kong: 120/min.',
                access: SCOPES.telemetryWrite,
                parameters: [pathId('deviceId', 'Id recebido no pareamento.')],
                body: {
                    schema: fromZod(passageBatchSchema),
                    example: {
                        clientId: '00000000-0000-4000-8000-000000000000',
                        events: [
                            {
                                eventId: '6f1c1a34-7a9e-4f0e-9a51-3c1d2b8e9f10',
                                occurredAt: '2026-11-17T12:00:00Z',
                                direction: 'in',
                            },
                        ],
                        device: { firmware: '1.0.0', uptimeSeconds: 3600, rssi: -61 },
                    },
                },
                ok: { 202: { description: 'Gravado.', schema: S.ref('Accepted') } },
            }),
        },
        '/passages': {
            get: operation({
                tag: 'Passagens',
                summary: 'Listar passagens',
                description: 'O cliente vê as dos próprios dispositivos; o administrador, todas.',
                access: SCOPES.passagesRead,
                parameters: listParameters(PASSAGE_QUERY_SCHEMA),
                ok: { 200: page('Passage') },
                errors: ['BadRequest'],
            }),
        },
        '/passages/summary': {
            get: operation({
                tag: 'Passagens',
                summary: 'Contagem por janela de tempo',
                description: 'Entradas e saídas somadas em janelas de tamanho fixo. Sem intervalo, as últimas 24 h. '
                    + 'Aceita os mesmos filtros de GET /passages (paginação e ordenação não se aplicam).',
                access: SCOPES.passagesRead,
                parameters: [
                    {
                        name: 'window',
                        in: 'query',
                        description: 'Tamanho da janela: número seguido de m, h ou d (1m a 31d). Máximo de 1000 janelas.',
                        schema: { type: 'string', pattern: '^\\d{1,4}[mhd]$', default: '1h' },
                    },
                    ...listParameters(PASSAGE_QUERY_SCHEMA).filter(p => !['page', 'limit', 'sort', 'fields'].includes(p.name)),
                ],
                ok: { 200: { description: 'Janelas.', schema: S.ref('PassageSummary') } },
                errors: ['BadRequest'],
            }),
        },
    }

    return {
        openapi: '3.1.0',
        info: {
            title: info.title,
            version: info.version,
            description: [
                'API com autenticação JWT (papéis administrador, gestor e cliente), jobs assíncronos, '
                + 'dispositivos ESP32 e passagens.',
                '',
                '**Teste rápido:** abra **Autenticação → POST /auth/login** e clique em *Execute* '
                + '(o exemplo já traz o admin local). '
                + 'O token da resposta é aplicado automaticamente em *Authorize* e vale para as próximas chamadas '
                + '(e continua lá se a página for recarregada).',
                '',
                'Erros seguem sempre o formato `{ code, message, issues? }`. Toda resposta traz `X-Request-ID`, '
                + 'o mesmo que aparece nos logs e na auditoria.',
                '',
                'Listagens aceitam filtros, ordenação, seleção de campos e paginação pela query string; o total vem no header '
                + '`X-Total-Count`. Campos fora da lista de cada rota são recusados com 400.',
            ].join('\n'),
        },
        servers: [{ url: '/', description: 'Mesmo endereço desta página (Kong em :8000 ou a API direto)' }],
        tags: [
            { name: 'Autenticação', description: 'Login, renovação de tokens e chave pública.' },
            { name: 'Sessões', description: 'Logout e revogação de sessões.' },
            { name: 'MFA', description: 'Autenticação multifator: aplicativo autenticador (TOTP) e códigos de recuperação.' },
            { name: 'Usuários', description: 'Gestores e clientes (cadastrados pelo administrador).' },
            { name: 'Jobs', description: 'Relatórios gerados em segundo plano.' },
            { name: 'Dispositivos', description: 'Pareamento e gestão das ESP32.' },
            { name: 'Passagens', description: 'Dados dos sensores (série temporal no InfluxDB).' },
            { name: 'Sistema', description: 'Saúde da aplicação.' },
        ],
        security: [{ bearerAuth: [] }],
        paths,
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'access_token de POST /auth/login (usuários) ou de POST /devices/claim (dispositivos).',
                },
            },
            schemas,
            responses,
            headers,
        },
    }
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>
