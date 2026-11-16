import type { UserRole } from '../model/user.ts'

/**
 * Escopos da API. Ficam dentro do token (claim "scope") e cada rota declara o que exige.
 * O sufixo ":any" libera o acesso a recursos de qualquer usuário (sem ele, só os próprios).
 */
export const SCOPES = {
    usersCreate: 'users:create',
    usersRead: 'users:read',
    usersReadAny: 'users:read:any',
    clientsRead: 'clients:read',
    jobsCreate: 'jobs:create',
    jobsRead: 'jobs:read',
    jobsReadAny: 'jobs:read:any',
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
    ],
    // cadastra jobs para clientes; vê os jobs que criou
    manager: [SCOPES.usersRead, SCOPES.clientsRead, SCOPES.jobsCreate, SCOPES.jobsRead],
    // vê apenas os jobs associados a ele
    client: [SCOPES.usersRead, SCOPES.jobsRead],
}
