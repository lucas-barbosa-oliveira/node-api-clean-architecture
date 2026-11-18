import { randomBytes } from 'node:crypto';
import type { ISessionRepository } from '../../src/application/port/session.repository.ts';
import type { IUserRepository } from '../../src/application/port/user.repository.ts';
import { isMfaChallenge, type LoginResult, type TokenPair } from '../../src/application/service/auth.service.ts';
import { MfaService } from '../../src/application/service/mfa.service.ts';
import type { UserRole } from '../../src/domain/model/user.ts';
import { InMemoryMfaChallengeRepository } from '../../src/infrastructure/repository/in-memory/in.memory.mfa.challenge.repository.ts';
import { AesSecretCipher } from '../../src/infrastructure/security/aes.secret.cipher.ts';
import { RecoveryCodes } from '../../src/infrastructure/security/recovery.codes.ts';
import { Totp } from '../../src/infrastructure/security/totp.ts';

/** Dependências de MFA do AuthService, em memória. */
export function makeMfa(users: IUserRepository, sessions: ISessionRepository, requiredRoles: UserRole[] = []) {
  const totp = new Totp();
  const mfa = new MfaService({
    users,
    sessions,
    totp,
    cipher: new AesSecretCipher(randomBytes(32)),
    recoveryCodes: new RecoveryCodes(),
    issuer: 'teste',
    requiredRoles,
  });
  return { mfa, mfaChallenges: new InMemoryMfaChallengeRepository(), totp };
}

/** O login devolveu tokens (e não o desafio de MFA). */
export function tokensOf(result: LoginResult): TokenPair {
  if (isMfaChallenge(result)) throw new Error('esperava tokens, veio o desafio de MFA');
  return result;
}

/** Código TOTP de um passo à frente/atrás (o mesmo passo não vale duas vezes). */
export const codeAt = (totp: Totp, secret: string, offsetSteps = 0) =>
  totp.codeAt(secret, new Date(Date.now() + offsetSteps * 30_000));
