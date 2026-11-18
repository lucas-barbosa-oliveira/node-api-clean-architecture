import mongoose from 'mongoose'
import { AUTH_METHODS, SESSION_REVOKE_REASONS, type AuthMethod, type SessionRevokeReason } from '../../../domain/model/session.ts'

export interface ISessionModel {
  _id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
  revokedReason?: SessionRevokeReason;
  userAgent?: string;
  ip?: string;
  amr?: AuthMethod[];
  createdAt: Date;
  updatedAt: Date;
}

export const sessionSchema = new mongoose.Schema<ISessionModel>(
    {
        _id: { type: String, required: true },
        userId: { type: String, required: true },
        refreshTokenHash: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        lastUsedAt: { type: Date },
        revokedAt: { type: Date },
        revokedReason: { type: String, enum: SESSION_REVOKE_REASONS },
        userAgent: { type: String },
        ip: { type: String },
        amr: { type: [{ type: String, enum: AUTH_METHODS }], default: undefined },
        createdAt: { type: Date, required: true },
        updatedAt: { type: Date, required: true },
    },
    { collection: 'sessions', versionKey: false },
)

// sessões ativas de um usuário (listagem e "sair de todos os dispositivos")
sessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 })
// limpeza periódica de sessões encerradas
sessionSchema.index({ expiresAt: 1 })
sessionSchema.index({ revokedAt: 1 })
