import type { Session, SessionRevokeReason } from '../../domain/model/session.ts'

export interface ISessionRepository {
  save(session: Session): Promise<void>;
  findById(id: string): Promise<Session | null>;
  /** Sessões não revogadas e não expiradas do usuário, mais recentes primeiro. */
  findActiveByUser(userId: string): Promise<Session[]>;
  /**
   * Troca o hash do refresh token somente se o atual ainda for `expectedHash` e a sessão estiver ativa
   * (operação atômica). Retorna false se outro refresh já rotacionou o token.
   */
  rotateRefreshToken(id: string, expectedHash: string, newHash: string): Promise<boolean>;
  /** Revoga todas as sessões ativas do usuário. Retorna quantas foram revogadas. */
  revokeAllByUser(userId: string, reason: SessionRevokeReason): Promise<number>;
  /** Remove sessões expiradas ou revogadas antes da data. */
  deleteEndedBefore(date: Date): Promise<number>;
}
