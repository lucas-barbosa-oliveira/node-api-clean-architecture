/**
 * Refresh token opaco (não é JWT): "<id da sessão>.<segredo aleatório>".
 * Só o hash do segredo é guardado; o id permite achar a sessão sem varrer a base.
 */
export interface IRefreshTokenCodec {
  create(sessionId: string): { token: string; hash: string };
  /** null se o formato for inválido. */
  parse(token: string): { sessionId: string; secretHash: string } | null;
  /** Comparação em tempo constante. */
  matches(secretHash: string, storedHash: string): boolean;
}
