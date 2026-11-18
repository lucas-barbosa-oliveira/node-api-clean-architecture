import type { User } from '../../domain/model/user.ts'
import type { ListQuery, Page } from '../query/list.query.ts'

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** Filtro, ordenação e paginação já validados (ver USER_QUERY_SCHEMA). */
  list(query: ListQuery): Promise<Page<User>>;
  /** Cria ou substitui. */
  save(user: User): Promise<void>;
  /**
   * Registra o uso do código TOTP do passo `step`, somente se for posterior ao último aceito (atômico).
   * false: o código (ou um mais novo) já foi usado; impede reapresentar um código interceptado.
   */
  consumeTotpStep(userId: string, step: number): Promise<boolean>;
  /** Remove o código de recuperação, se ainda existir (atômico). false se já foi usado ou não existe. */
  consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean>;
}
