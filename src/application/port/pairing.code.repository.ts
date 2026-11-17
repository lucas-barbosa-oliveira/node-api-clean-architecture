import type { PairingCode } from '../../domain/model/pairing.code.ts'

export interface IPairingCodeRepository {
  save(code: PairingCode): Promise<void>;
  /**
   * Marca o código como usado e o associa ao dispositivo, somente se ainda estiver válido (não usado e não expirado).
   * Operação atômica: dois dispositivos com o mesmo código não conseguem usá-lo. Retorna null se não for possível.
   */
  consume(codeHash: string, deviceId: string): Promise<PairingCode | null>;
}
