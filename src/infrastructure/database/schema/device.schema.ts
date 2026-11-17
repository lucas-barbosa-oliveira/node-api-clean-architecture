import mongoose from 'mongoose'
import { DEVICE_STATUSES, type DeviceStatus } from '../../../domain/model/device.ts'

export interface IDeviceModel {
  _id: string;
  clientId: string;
  name: string;
  hardwareId?: string;
  firmware?: string;
  status: DeviceStatus;
  revokedAt?: Date;
  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const deviceSchema = new mongoose.Schema<IDeviceModel>(
    {
        _id: { type: String, required: true },
        clientId: { type: String, required: true },
        name: { type: String, required: true },
        hardwareId: { type: String },
        firmware: { type: String },
        status: { type: String, required: true, enum: DEVICE_STATUSES },
        revokedAt: { type: Date },
        lastSeenAt: { type: Date },
        createdAt: { type: Date, required: true },
        updatedAt: { type: Date, required: true },
    },
    { collection: 'devices', versionKey: false },
)

deviceSchema.index({ clientId: 1, createdAt: -1 })
deviceSchema.index({ hardwareId: 1, status: 1 })
