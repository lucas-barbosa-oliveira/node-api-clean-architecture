import { Device } from '../../domain/model/device.ts'
import type { IDeviceModel } from '../database/schema/index.ts'
import { BaseMapper } from './entity.mapper.ts'

const toDate = (value: unknown): Date | undefined =>
    value == null ? undefined : new Date(value as string | number | Date)

export class DeviceMapper extends BaseMapper<Device, IDeviceModel> {
    public modelToModelEntity(device: Device): IDeviceModel {
        return {
            _id: device.id,
            clientId: device.clientId,
            name: device.name,
            hardwareId: device.hardwareId,
            firmware: device.firmware,
            status: device.status,
            revokedAt: device.revokedAt,
            lastSeenAt: device.lastSeenAt,
            createdAt: device.createdAt,
            updatedAt: device.updatedAt,
        }
    }

    public jsonToModel(json: IDeviceModel): Device {
        return new Device({
            id: json._id,
            clientId: json.clientId,
            name: json.name,
            hardwareId: json.hardwareId,
            firmware: json.firmware,
            status: json.status,
            revokedAt: toDate(json.revokedAt),
            lastSeenAt: toDate(json.lastSeenAt),
            createdAt: new Date(json.createdAt),
            updatedAt: new Date(json.updatedAt),
        })
    }
}
