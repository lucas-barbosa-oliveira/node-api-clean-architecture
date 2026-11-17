import { PairingCode } from '../../domain/model/pairing.code.ts'
import type { IPairingCodeModel } from '../database/schema/index.ts'
import { BaseMapper } from './entity.mapper.ts'

const toDate = (value: unknown): Date | undefined =>
    value == null ? undefined : new Date(value as string | number | Date)

export class PairingCodeMapper extends BaseMapper<PairingCode, IPairingCodeModel> {
    public modelToModelEntity(code: PairingCode): IPairingCodeModel {
        return {
            _id: code.id,
            clientId: code.clientId,
            codeHash: code.codeHash,
            expiresAt: code.expiresAt,
            createdBy: code.createdBy,
            usedAt: code.usedAt,
            deviceId: code.deviceId,
            createdAt: code.createdAt,
            updatedAt: code.updatedAt,
        }
    }

    public jsonToModel(json: IPairingCodeModel): PairingCode {
        return new PairingCode({
            id: json._id,
            clientId: json.clientId,
            codeHash: json.codeHash,
            expiresAt: new Date(json.expiresAt),
            createdBy: json.createdBy,
            usedAt: toDate(json.usedAt),
            deviceId: json.deviceId,
            createdAt: new Date(json.createdAt),
            updatedAt: new Date(json.updatedAt),
        })
    }
}
