import { Entity, type EntityProps } from './entity.ts'

export const DEVICE_STATUSES = ['active', 'revoked'] as const
export type DeviceStatus = (typeof DEVICE_STATUSES)[number]

export type DeviceProps = EntityProps & {
    /** Cliente dono do dispositivo (definido pelo código de pareamento, nunca pelo próprio dispositivo). */
    clientId: string;
    name: string;
    /** Identificador físico (ex.: MAC da ESP32). Repareamento do mesmo hardware substitui o registro antigo. */
    hardwareId?: string;
    firmware?: string;
    status?: DeviceStatus;
    revokedAt?: Date;
    lastSeenAt?: Date;
}

/** Um sensor (ex.: ESP32) pareado a um cliente. */
export class Device extends Entity {
    public readonly clientId: string
    public readonly name: string
    public readonly hardwareId?: string
    public firmware?: string
    public status: DeviceStatus
    public revokedAt?: Date
    public lastSeenAt?: Date

    constructor(props: DeviceProps) {
        super(props)
        this.clientId = props.clientId
        this.name = props.name
        this.hardwareId = props.hardwareId
        this.firmware = props.firmware
        this.status = props.status ?? 'active'
        this.revokedAt = props.revokedAt
        this.lastSeenAt = props.lastSeenAt
    }

    public static pair(data: { clientId: string; name: string; hardwareId?: string; firmware?: string }): Device {
        return new Device(data)
    }

    public isActive(): boolean {
        return this.status === 'active'
    }

    public revoke(): void {
        if (this.status === 'revoked') return
        this.status = 'revoked'
        this.revokedAt = new Date()
        this.touch()
    }
}
