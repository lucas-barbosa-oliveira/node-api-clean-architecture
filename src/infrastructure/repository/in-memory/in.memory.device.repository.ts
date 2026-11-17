import type { IDeviceRepository } from '../../../application/port/device.repository.ts'
import type { ListQuery, Page } from '../../../application/query/list.query.ts'
import type { Device } from '../../../domain/model/device.ts'
import type { IDeviceModel } from '../../database/schema/index.ts'
import { DeviceMapper } from '../../mapper/device.mapper.ts'
import { queryDocs } from './in.memory.query.ts'

export class InMemoryDeviceRepository implements IDeviceRepository {
    #docs = new Map<string, IDeviceModel>()
    #mapper = new DeviceMapper()

    public async save(device: Device): Promise<void> {
        this.#docs.set(device.id, structuredClone(this.#mapper.modelToModelEntity(device)))
    }

    public async findById(id: string): Promise<Device | null> {
        const doc = this.#docs.get(id)
        return this.#mapper.transform(doc && structuredClone(doc))
    }

    public async findActiveByHardwareId(hardwareId: string): Promise<Device[]> {
        const docs = [...this.#docs.values()].filter(doc => doc.hardwareId === hardwareId && doc.status === 'active')
        return this.#mapper.transform(docs.map(doc => structuredClone(doc)))
    }

    public async list(query: ListQuery): Promise<Page<Device>> {
        const { items, total } = queryDocs([...this.#docs.values()].map(doc => structuredClone(doc)), query)
        return { items: this.#mapper.transform(items), total }
    }

    public async markSeen(id: string, at: Date, firmware?: string): Promise<void> {
        const doc = this.#docs.get(id)
        if (!doc) return
        doc.lastSeenAt = at
        if (firmware) doc.firmware = firmware
    }
}
