import mongoose from 'mongoose'

export interface IMfaChallengeModel {
  _id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  attempts: number;
  usedAt?: Date;
  userAgent?: string;
  ip?: string;
  createdAt: Date;
  updatedAt: Date;
}

export const mfaChallengeSchema = new mongoose.Schema<IMfaChallengeModel>(
    {
        _id: { type: String, required: true },
        userId: { type: String, required: true },
        tokenHash: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        attempts: { type: Number, required: true, default: 0 },
        usedAt: { type: Date },
        userAgent: { type: String },
        ip: { type: String },
        createdAt: { type: Date, required: true },
        updatedAt: { type: Date, required: true },
    },
    { collection: 'mfa_challenges', versionKey: false },
)

// desafios valem minutos: o próprio Mongo apaga 1 hora depois de expirarem (índice TTL)
mfaChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 })
