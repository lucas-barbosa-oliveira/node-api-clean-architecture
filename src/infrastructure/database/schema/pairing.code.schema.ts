import mongoose from 'mongoose'

export interface IPairingCodeModel {
  _id: string;
  clientId: string;
  codeHash: string;
  expiresAt: Date;
  createdBy: string;
  usedAt?: Date;
  deviceId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const pairingCodeSchema = new mongoose.Schema<IPairingCodeModel>(
    {
        _id: { type: String, required: true },
        clientId: { type: String, required: true },
        codeHash: { type: String, required: true, unique: true },
        expiresAt: { type: Date, required: true },
        createdBy: { type: String, required: true },
        usedAt: { type: Date },
        deviceId: { type: String },
        createdAt: { type: Date, required: true },
        updatedAt: { type: Date, required: true },
    },
    { collection: 'pairing_codes', versionKey: false },
)

// o próprio Mongo apaga os códigos 1 dia depois de expirarem (índice TTL)
pairingCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 })
