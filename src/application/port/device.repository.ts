import type { Device } from '../../domain/model/device.ts'
import type { ListQuery, Page } from '../query/list.query.ts'

export interface IDeviceRepository {
  save(device: Device): Promise<void>;
  findById(id: string): Promise<Device | null>;
  findActiveByHardwareId(hardwareId: string): Promise<Device[]>;
  list(query: ListQuery): Promise<Page<Device>>;
  /** Atualiza "visto por último" (e o firmware, se informado) sem reescrever o registro inteiro. */
  markSeen(id: string, at: Date, firmware?: string): Promise<void>;
}
