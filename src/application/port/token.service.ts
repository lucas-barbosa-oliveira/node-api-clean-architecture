import type { Actor } from '../../domain/auth/actor.ts'

export type IssuedToken = { accessToken: string; expiresIn: number }

export interface ITokenService {
  issue(actor: Actor): Promise<IssuedToken>;
  /** Valida assinatura, emissor, audiência e expiração. Lança UnauthorizedError se inválido. */
  verify(token: string): Promise<Actor>;
  /** Chaves públicas (JWKS) para outros serviços validarem os tokens. */
  publicJwks(): Promise<{ keys: object[] }>;
}
