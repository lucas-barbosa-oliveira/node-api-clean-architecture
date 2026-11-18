/** Códigos de recuperação: para entrar sem o aplicativo autenticador (celular perdido). Cada um vale uma vez. */
export interface IRecoveryCodes {
  /** Códigos novos (mostrados uma única vez ao usuário) e os hashes que ficam guardados. */
  generate(count: number): { codes: string[]; hashes: string[] };
  /** Hash do código informado, ignorando hífens, espaços e maiúsculas; null se não tiver o formato de um código. */
  hash(code: string): string | null;
}
