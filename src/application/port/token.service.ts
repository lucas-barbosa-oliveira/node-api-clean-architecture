import type { Actor } from '../../domain/auth/actor.ts'

export type IssuedToken = { accessToken: string; expiresIn: number }

export interface ITokenService {
  /** `expiresInSeconds` substitui a validade padrão (ex.: token de dispositivo, de longa duração). */
  issue(actor: Actor, options?: { expiresInSeconds?: number }): Promise<IssuedToken>;
  /** Valida assinatura, emissor, audiência e expiração. Lança UnauthorizedError se inválido. */
  verify(token: string): Promise<Actor>;
  /** Chaves públicas (JWKS) para outros serviços validarem os tokens. */
  publicJwks(): Promise<{ keys: object[] }>;
}
