import type { User, UserRole } from '../../domain/model/user.ts'

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByRole(role: UserRole): Promise<User[]>;
  save(user: User): Promise<void>;
}
