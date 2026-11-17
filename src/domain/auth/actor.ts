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
}

export const hasScope = (actor: Actor, scope: Scope): boolean => actor.scopes.includes(scope)
