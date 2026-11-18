import type { PrincipalRole, Scope } from './scopes.ts'

/** Quem está executando a operação (extraído do token já validado). */
export type Actor = {
    /** Id do usuário ou, quando role = 'device', id do dispositivo. */
    userId: string;
    role: PrincipalRole;
    scopes: readonly string[];
    /** Sessão de login do token (claim "sid"). Ausente em atores internos, como tarefas de background. */
    sessionId?: string;
    /** Cliente dono do dispositivo (só para role = 'device'). */
    clientId?: string;
    /** Como o usuário se autenticou (claim "amr"): ["pwd"] ou, com segundo fator, ["pwd", "otp", "mfa"]. */
    amr?: readonly string[];
    /**
     * O papel exige MFA e o usuário ainda não ativou: o token não tem escopos e só serve para configurar o MFA
     * (e para as rotas de sessão). Depois de ativar, POST /auth/refresh devolve os escopos do papel.
     */
    mfaEnrollmentRequired?: boolean;
}

export const hasScope = (actor: Actor, scope: Scope): boolean => actor.scopes.includes(scope)
