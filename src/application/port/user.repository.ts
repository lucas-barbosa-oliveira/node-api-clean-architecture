import type { User } from '../../domain/model/user.ts'
import type { ListQuery, Page } from '../query/list.query.ts'

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** Filtro, ordenação e paginação já validados (ver USER_QUERY_SCHEMA). */
  list(query: ListQuery): Promise<Page<User>>;
  save(user: User): Promise<void>;
}
