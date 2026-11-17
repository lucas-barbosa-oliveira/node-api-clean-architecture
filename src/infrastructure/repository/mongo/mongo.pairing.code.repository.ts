import type { Model } from 'mongoose'
import type { IPairingCodeRepository } from '../../../application/port/pairing.code.repository.ts'
import type { PairingCode } from '../../../domain/model/pairing.code.ts'
import type { IPairingCodeModel } from '../../database/schema/index.ts'
import { PairingCodeMapper } from '../../mapper/pairing.code.mapper.ts'
import { BaseMongoRepository } from '../base/base.repository.ts'

export class MongoPairingCodeRepository
    extends BaseMongoRepository<PairingCode, IPairingCodeModel>
    implements IPairingCodeRepository {
    constructor(model: Model<IPairingCodeModel>) {
        super(model, new PairingCodeMapper())
    }

    public async save(code: PairingCode): Promise<void> {
        await this.create(code)
    }

    /** findOneAndUpdate com as condições de validade no filtro: só uma ESP32 consegue usar o código. */
    public consume(codeHash: string, deviceId: string): Promise<PairingCode | null> {
        return this.run(async () => {
            const now = new Date()
            const doc = await this.model
                .findOneAndUpdate(
                    { codeHash, usedAt: { $exists: false }, expiresAt: { $gt: now } },
                    { $set: { usedAt: now, deviceId, updatedAt: now } },
                    { returnDocument: 'after' },
                )
                .lean()
            return this.mapper.transform(doc as IPairingCodeModel | null)
        })
    }
}
