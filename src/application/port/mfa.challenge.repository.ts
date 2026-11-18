import type { MfaChallenge } from '../../domain/model/mfa.challenge.ts'

export interface IMfaChallengeRepository {
  save(challenge: MfaChallenge): Promise<void>;
  /**
   * Gasta uma tentativa (atômico), somente se o desafio existir com esse hash, não tiver sido usado, não tiver
   * expirado e ainda tiver tentativas. Retorna o desafio já com a tentativa contada, ou null.
   * A tentativa é contada antes de conferir o código: requisições em paralelo não ultrapassam o limite.
   */
  reserveAttempt(id: string, tokenHash: string): Promise<MfaChallenge | null>;
  /** Marca como usado (atômico). false se outra requisição já usou. */
  consume(id: string): Promise<boolean>;
}
