import type { Device } from '../../domain/model/device.ts'
import type { User } from '../../domain/model/user.ts'
import type { OutboxMessage } from '../port/outbox.ts'

/**
 * Eventos que este serviço publica para os outros microsserviços. Formato no padrão dos outros serviços:
 * event_name + timestamp + o recurso (JSON público, o mesmo das respostas HTTP).
 *
 *   exchange  routing key       evento
 *   users     users.created     UserCreatedEvent
 *   devices   devices.paired    DevicePairedEvent
 *   devices   devices.revoked   DeviceRevokedEvent
 *   audit     audit.request     RequestAuditEvent (ver AuditService)
 */
const message = (exchange: string, routingKey: string, eventName: string, payload: Record<string, unknown>): OutboxMessage => ({
    exchange,
    routingKey,
    event: { event_name: eventName, timestamp: new Date().toISOString(), ...JSON.parse(JSON.stringify(payload)) },
})

export const IntegrationEvents = {
    userCreated: (user: User) => message('users', 'users.created', 'UserCreatedEvent', { user }),
    devicePaired: (device: Device) => message('devices', 'devices.paired', 'DevicePairedEvent', { device }),
    deviceRevoked: (device: Device, reason: 'revoked_by_user' | 'replaced_by_new_pairing') =>
        message('devices', 'devices.revoked', 'DeviceRevokedEvent', { device, reason }),
}
