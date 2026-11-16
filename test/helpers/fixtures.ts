import type { Actor } from '../../src/domain/auth/actor.ts';
import { ROLE_SCOPES } from '../../src/domain/auth/scopes.ts';
import { User, type UserRole } from '../../src/domain/model/user.ts';

/** Ator com os escopos reais do papel (os mesmos que iriam no token). */
export const actorFor = (role: UserRole, userId: string = crypto.randomUUID()): Actor => ({
  userId,
  role,
  scopes: ROLE_SCOPES[role],
});

export const newUser = (role: UserRole, overrides: Partial<{ name: string; email: string }> = {}) =>
  User.create({
    name: overrides.name ?? `Usuário ${role}`,
    email: overrides.email ?? `${crypto.randomUUID()}@teste.com`,
    role,
    passwordHash: 'scrypt$hash-fake',
  });

export const actorOf = (user: User): Actor => actorFor(user.role, user.id);
