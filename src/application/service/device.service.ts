import { createHash, randomInt, randomUUID } from 'node:crypto'
import { hasScope, type Actor } from '../../domain/auth/actor.ts'
import { DEVICE_SCOPES, SCOPES } from '../../domain/auth/scopes.ts'
import { NotFoundError, UnauthorizedError } from '../../domain/error/index.ts'
import { Device } from '../../domain/model/device.ts'
import { PairingCode } from '../../domain/model/pairing.code.ts'
import {
    PAIRING_CODE_ALPHABET,
    PAIRING_CODE_LENGTH,
    validateClaimDevice,
} from '../../domain/validator/device.validator.ts'
import { IntegrationEvents } from '../event/integration.events.ts'
import type { IDeviceRepository } from '../port/device.repository.ts'
import type { IOutbox } from '../port/outbox.ts'
import type { IPairingCodeRepository } from '../port/pairing.code.repository.ts'
import type { ITokenService } from '../port/token.service.ts'
import type { IUnitOfWork } from '../port/unit.of.work.ts'
import type { IUserRepository } from '../port/user.repository.ts'
import { and, type ListQuery, type Page } from '../query/list.query.ts'

/** O código tem ~40 bits; com validade curta, uso único e rate limit no Kong, um SHA-256 basta para guardá-lo. */
const hashCode = (code: string) => createHash('sha256').update(code).digest('base64url')

export type IssuedPairingCode = { code: string; expiresAt: Date; expiresIn: number }
export type ClaimedDevice = { device: Device; clientId: string; accessToken: string; expiresIn: number }

export class DeviceService {
    #devices: IDeviceRepository
    #codes: IPairingCodeRepository
    #users: IUserRepository
    #tokens: ITokenService
    #codeTtlSeconds: number
    #deviceTokenTtlSeconds: number
    #outbox: IOutbox
    #unitOfWork: IUnitOfWork

    constructor(deps: {
        devices: IDeviceRepository;
        pairingCodes: IPairingCodeRepository;
        users: IUserRepository;
        tokens: ITokenService;
        pairingCodeTtlSeconds: number;
        deviceTokenTtlSeconds: number;
        outbox: IOutbox;
        unitOfWork: IUnitOfWork;
    }) {
        this.#outbox = deps.outbox
        this.#unitOfWork = deps.unitOfWork
        this.#devices = deps.devices
        this.#codes = deps.pairingCodes
        this.#users = deps.users
        this.#tokens = deps.tokens
        this.#codeTtlSeconds = deps.pairingCodeTtlSeconds
        this.#deviceTokenTtlSeconds = deps.deviceTokenTtlSeconds
    }

    /**
     * Gera um código de pareamento para o cliente. O próprio cliente gera para si; com devices:manage:any, para qualquer cliente.
     * O código só é devolvido aqui: no banco fica apenas o hash.
     */
    public async createPairingCode(actor: Actor, clientId: string): Promise<IssuedPairingCode> {
        const canManageAny = hasScope(actor, SCOPES.devicesManageAny)
        const client = canManageAny || clientId === actor.userId ? await this.#users.findById(clientId) : null
        if (client?.role !== 'client') throw new NotFoundError('Cliente não encontrado')

        const randomChar = () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)]
        const code = Array.from({ length: PAIRING_CODE_LENGTH }, randomChar).join('')
        const pairing = PairingCode.issue({
            clientId,
            codeHash: hashCode(code),
            createdBy: actor.userId,
            ttlSeconds: this.#codeTtlSeconds,
        })
        await this.#codes.save(pairing)
        return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: pairing.expiresAt, expiresIn: this.#codeTtlSeconds }
    }

    /**
     * A ESP32 troca o código digitado pelo id do cliente e por um token de dispositivo.
     * O token é o que autentica os envios: o clientId sozinho não é segredo e não basta para gravar dados.
     * Uso do código, revogação do registro anterior, novo dispositivo e eventos: tudo na mesma transação.
     */
    public async claim(input: unknown): Promise<ClaimedDevice> {
        const data = validateClaimDevice(input)
        const deviceId = randomUUID()

        const device = await this.#unitOfWork.run(async () => {
            const pairing = await this.#codes.consume(hashCode(data.code), deviceId)
            if (!pairing) throw new UnauthorizedError('Código de pareamento inválido, expirado ou já usado')

            // o mesmo hardware pareado de novo (ex.: ESP32 resetada ou passada para outro cliente) invalida o registro anterior
            if (data.hardwareId) {
                for (const previous of await this.#devices.findActiveByHardwareId(data.hardwareId)) {
                    previous.revoke()
                    await this.#devices.save(previous)
                    await this.#outbox.add(IntegrationEvents.deviceRevoked(previous, 'replaced_by_new_pairing'))
                }
            }

            const created = new Device({
                id: deviceId,
                clientId: pairing.clientId,
                name: data.name,
                hardwareId: data.hardwareId,
                firmware: data.firmware,
            })
            await this.#devices.save(created)
            await this.#outbox.add(IntegrationEvents.devicePaired(created))
            return created
        })

        const token = await this.#tokens.issue(
            { userId: device.id, role: 'device', scopes: DEVICE_SCOPES, clientId: device.clientId },
            { expiresInSeconds: this.#deviceTokenTtlSeconds },
        )
        return { device, clientId: device.clientId, accessToken: token.accessToken, expiresIn: token.expiresIn }
    }

    /** Cliente vê os próprios dispositivos; devices:read:any vê todos. */
    public list(actor: Actor, query: ListQuery): Promise<Page<Device>> {
        const access = hasScope(actor, SCOPES.devicesReadAny) ? {} : { clientId: actor.userId }
        return this.#devices.list({ ...query, filter: and(access, query.filter) })
    }

    /** Revoga o dispositivo: o token dele deixa de valer na hora. Dispositivo de outro cliente responde 404. */
    public async revoke(actor: Actor, deviceId: string): Promise<void> {
        const device = await this.#devices.findById(deviceId)
        if (!device || (!hasScope(actor, SCOPES.devicesManageAny) && device.clientId !== actor.userId)) {
            throw new NotFoundError('Dispositivo não encontrado')
        }
        device.revoke()
        await this.#unitOfWork.run(async () => {
            await this.#devices.save(device)
            await this.#outbox.add(IntegrationEvents.deviceRevoked(device, 'revoked_by_user'))
        })
    }

    /** Usado na autenticação de cada envio: o token só vale enquanto o dispositivo estiver ativo e com o mesmo cliente. */
    public async isActive(deviceId: string, clientId: string | undefined): Promise<boolean> {
        const device = await this.#devices.findById(deviceId)
        return Boolean(device?.isActive() && device.clientId === clientId)
    }
}
