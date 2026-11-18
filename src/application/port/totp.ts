/** Senhas de uso único baseadas em tempo (TOTP, RFC 6238): o que os aplicativos autenticadores geram. */
export interface ITotp {
  /** Segredo novo, em base32 (o formato que os aplicativos aceitam digitado ou por QR code). */
  generateSecret(): string;
  /**
   * Confere o código contra o segredo, tolerando um passo de 30 s para cada lado (relógios dessincronizados).
   * Retorna o passo de tempo do código (para impedir reuso) ou null se não confere.
   */
  verify(secret: string, code: string, now?: Date): number | null;
  /** URI otpauth:// para o QR code (Google Authenticator, Microsoft Authenticator, 1Password, Authy...). */
  keyUri(data: { secret: string; account: string; issuer: string }): string;
}
