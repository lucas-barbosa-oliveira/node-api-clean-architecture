import { Entity, type EntityProps } from './entity.ts'

export type PairingCodeProps = EntityProps & {
    clientId: string;
    /** SHA-256 do código normalizado. O código em si só é mostrado uma vez, na criação. */
    codeHash: string;
    expiresAt: Date;
    /** Quem gerou (o próprio cliente ou um administrador). */
    createdBy: string;
    usedAt?: Date;
    deviceId?: string;
}

/** Código curto, de uso único e com validade, que o cliente digita na ESP32 para associá-la à sua conta. */
export class PairingCode extends Entity {
    public readonly clientId: string
    public readonly codeHash: string
    public readonly expiresAt: Date
    public readonly createdBy: string
    public usedAt?: Date
    public deviceId?: string

    constructor(props: PairingCodeProps) {
        super(props)
        this.clientId = props.clientId
        this.codeHash = props.codeHash
        this.expiresAt = props.expiresAt
        this.createdBy = props.createdBy
        this.usedAt = props.usedAt
        this.deviceId = props.deviceId
    }

    public static issue(data: { clientId: string; codeHash: string; createdBy: string; ttlSeconds: number }): PairingCode {
        const { ttlSeconds, ...rest } = data
        return new PairingCode({ ...rest, expiresAt: new Date(Date.now() + ttlSeconds * 1000) })
    }

    public isUsable(now = new Date()): boolean {
        return !this.usedAt && this.expiresAt > now
    }
}
