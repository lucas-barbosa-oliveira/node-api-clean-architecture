import type { UserRole } from '../model/user.ts'

/** Quem pode estar por trás de um token: um usuário (com papel) ou um dispositivo pareado. */
export const PRINCIPAL_ROLES = ['admin', 'manager', 'client', 'device'] as const
export type PrincipalRole = (typeof PRINCIPAL_ROLES)[number]

/**
 * Escopos da API. Ficam dentro do token (claim "scope") e cada rota declara o que exige.
 * O sufixo ":any" libera o acesso a recursos de qualquer usuário (sem ele, só os próprios).
 * Gerenciar as próprias sessões (logout, listar, revogar) e o próprio MFA não exige escopo: basta estar autenticado.
 */
export const SCOPES = {
    usersCreate: 'users:create',
    usersRead: 'users:read',
    usersReadAny: 'users:read:any',
    clientsRead: 'clients:read',
    jobsCreate: 'jobs:create',
    jobsRead: 'jobs:read',
    jobsReadAny: 'jobs:read:any',
    sessionsRevokeAny: 'sessions:revoke:any',
    /** Redefinir o MFA de outro usuário (ex.: perdeu o celular e os códigos de recuperação). */
    mfaResetAny: 'mfa:reset:any',
    devicesRead: 'devices:read',
    devicesReadAny: 'devices:read:any',
    devicesManage: 'devices:manage',
    devicesManageAny: 'devices:manage:any',
    passagesRead: 'passages:read',
    passagesReadAny: 'passages:read:any',
    telemetryWrite: 'telemetry:write',
} as const

export type Scope = (typeof SCOPES)[keyof typeof SCOPES]

/** Escopos concedidos a cada papel no momento do login. */
export const ROLE_SCOPES: Record<UserRole, readonly Scope[]> = {
    // cadastra gestores e clientes; enxerga tudo
    admin: [
        SCOPES.usersCreate,
        SCOPES.usersRead,
        SCOPES.usersReadAny,
        SCOPES.clientsRead,
        SCOPES.jobsRead,
        SCOPES.jobsReadAny,
        SCOPES.sessionsRevokeAny,
        SCOPES.mfaResetAny,
        SCOPES.devicesRead,
        SCOPES.devicesReadAny,
        SCOPES.devicesManage,
        SCOPES.devicesManageAny,
        SCOPES.passagesRead,
        SCOPES.passagesReadAny,
    ],
    // cadastra jobs para clientes; vê os jobs que criou
    manager: [SCOPES.usersRead, SCOPES.clientsRead, SCOPES.jobsCreate, SCOPES.jobsRead],
    // vê apenas os jobs associados a ele; pareia e gerencia os próprios dispositivos e vê as passagens deles
    client: [SCOPES.usersRead, SCOPES.jobsRead, SCOPES.devicesRead, SCOPES.devicesManage, SCOPES.passagesRead],
}

/** Um dispositivo só envia dados: o token dele não serve para nenhuma outra rota. */
export const DEVICE_SCOPES: readonly Scope[] = [SCOPES.telemetryWrite]
