/**
 * Cifra segredos que a aplicação precisa ler de volta (ex.: o segredo TOTP, que não pode ser guardado como hash).
 * Quem lê o banco sem a chave não consegue gerar códigos. Assíncrona: a chave pode estar fora do processo (Vault).
 */
export interface ISecretCipher {
  encrypt(plaintext: string): Promise<string>;
  /** Lança erro se o texto foi adulterado ou cifrado com uma chave desconhecida. */
  decrypt(sealed: string): Promise<string>;
  /**
   * Cifrado com uma chave (ou versão de chave) antiga: devolve cifrado de novo com a atual; null se já está atual.
   * Usado no próximo uso de cada segredo, para a rotação não exigir migração.
   */
  refresh(sealed: string): Promise<string | null>;
}
