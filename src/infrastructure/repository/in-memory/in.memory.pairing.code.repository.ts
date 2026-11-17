import type { IPairingCodeRepository } from '../../../application/port/pairing.code.repository.ts'
import type { PairingCode } from '../../../domain/model/pairing.code.ts'
import type { IPairingCodeModel } from '../../database/schema/index.ts'
import { PairingCodeMapper } from '../../mapper/pairing.code.mapper.ts'

export class InMemoryPairingCodeRepository implements IPairingCodeRepository {
    #docs = new Map<string, IPairingCodeModel>()
    #mapper = new PairingCodeMapper()

    public async save(code: PairingCode): Promise<void> {
        this.#docs.set(code.id, structuredClone(this.#mapper.modelToModelEntity(code)))
    }

    // sem await entre a leitura e a escrita: atômico no event loop
    public async consume(codeHash: string, deviceId: string): Promise<PairingCode | null> {
        const now = new Date()
        const doc = [...this.#docs.values()].find(item => item.codeHash === codeHash)
        if (!doc || doc.usedAt || doc.expiresAt <= now) return null
        Object.assign(doc, { usedAt: now, deviceId, updatedAt: now })
        return this.#mapper.transform(structuredClone(doc))
    }
}
