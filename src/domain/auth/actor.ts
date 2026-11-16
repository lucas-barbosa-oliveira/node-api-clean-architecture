import type { UserRole } from '../model/user.ts'
import type { Scope } from './scopes.ts'

/** Quem está executando a operação (extraído do token já validado). */
export type Actor = {
    userId: string;
    role: UserRole;
    scopes: readonly string[];
}

export const hasScope = (actor: Actor, scope: Scope): boolean => actor.scopes.includes(scope)
