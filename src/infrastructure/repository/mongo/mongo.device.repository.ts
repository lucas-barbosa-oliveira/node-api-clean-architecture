import type { Model } from 'mongoose'
import type { IDeviceRepository } from '../../../application/port/device.repository.ts'
import type { ListQuery, Page } from '../../../application/query/list.query.ts'
import type { Device } from '../../../domain/model/device.ts'
import type { IDeviceModel } from '../../database/schema/index.ts'
import { DeviceMapper } from '../../mapper/device.mapper.ts'
import { BaseMongoRepository } from '../base/base.repository.ts'

export class MongoDeviceRepository extends BaseMongoRepository<Device, IDeviceModel> implements IDeviceRepository {
    constructor(model: Model<IDeviceModel>) {
        super(model, new DeviceMapper())
    }

    public save(device: Device): Promise<void> {
        return this.upsert(device)
    }

    public findActiveByHardwareId(hardwareId: string): Promise<Device[]> {
        return this.find({ hardwareId, status: 'active' })
    }

    public list(query: ListQuery): Promise<Page<Device>> {
        return this.findPage(query)
    }

    public markSeen(id: string, at: Date, firmware?: string): Promise<void> {
        return this.run(async () => {
            await this.model.updateOne({ _id: id }, { $set: { lastSeenAt: at, ...(firmware && { firmware }) } })
        })
    }
}
