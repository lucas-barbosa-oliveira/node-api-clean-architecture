import mongoose from 'mongoose'
import { USER_ROLES, type UserRole } from '../../../domain/model/user.ts'

/** Documento do usuário como é guardado no Mongo (não estende Document: ver README). */
export interface IUserModel {
  _id: string;
  name: string;
  email: string;
  role: UserRole;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

// Regras de negócio ficam em domain/validator; aqui só restrições estruturais.
export const userSchema = new mongoose.Schema<IUserModel>(
    {
        _id: { type: String, required: true },
        name: { type: String, required: true },
        email: { type: String, required: true, unique: true },
        role: { type: String, required: true, enum: USER_ROLES },
        passwordHash: { type: String, required: true },
        createdAt: { type: Date, required: true },
        updatedAt: { type: Date, required: true },
    },
    { collection: 'users', versionKey: false },
)

userSchema.index({ role: 1 })
