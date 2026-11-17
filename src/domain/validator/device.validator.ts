import { z } from 'zod'
import { ValidationError } from '../error/index.ts'
import { PASSAGE_DIRECTIONS } from '../model/passage.ts'

/** Alfabeto sem caracteres que se confundem ao digitar (0/O, 1/I/L). */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIRING_CODE_LENGTH = 8

/** Aceita o código com ou sem hífen/espaços e em minúsculas: "k7qm-9xrt" vira "K7QM9XRT". */
export const normalizePairingCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

const MAX_EVENTS_PER_BATCH = 500
/** Eventos guardados offline por mais tempo que isso são recusados. */
export const MAX_EVENT_AGE_MS = 30 * 86_400_000
/** Tolerância para relógio do dispositivo adiantado. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000

export const claimDeviceSchema = z.object({
    code: z
        .string()
        .transform(normalizePairingCode)
        .pipe(z.string().length(PAIRING_CODE_LENGTH, 'Código inválido')),
    name: z.string().trim().min(1).max(60).default('ESP32'),
    /** MAC da ESP32, ex.: "24:6F:28:AB:CD:EF". */
    hardwareId: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'Use o MAC no formato AA:BB:CC:DD:EE:FF')
        .optional(),
    firmware: z.string().trim().min(1).max(32).optional(),
})

const eventSchema = z.object({
    eventId: z.uuid('eventId deve ser um UUID'),
    occurredAt: z.iso
        .datetime({ offset: true, message: 'Use data ISO 8601 com fuso, ex.: 2026-11-16T21:43:12.481Z' })
        .transform(value => new Date(value))
        .refine(date => date.getTime() <= Date.now() + MAX_CLOCK_SKEW_MS, 'Data no futuro: confira o NTP do dispositivo')
        .refine(date => date.getTime() >= Date.now() - MAX_EVENT_AGE_MS, 'Evento com mais de 30 dias'),
    direction: z.enum(PASSAGE_DIRECTIONS),
    sequence: z.int().min(0).optional(),
})

export const passageBatchSchema = z.object({
    clientId: z.uuid('clientId deve ser um UUID'),
    events: z.array(eventSchema).min(1, 'Envie ao menos um evento').max(MAX_EVENTS_PER_BATCH),
    device: z
        .object({
            firmware: z.string().trim().min(1).max(32).optional(),
            uptimeSeconds: z.int().min(0).optional(),
            rssi: z.int().min(-127).max(0).optional(),
        })
        .optional(),
})

export type ClaimDeviceInput = z.infer<typeof claimDeviceSchema>
export type PassageBatchInput = z.infer<typeof passageBatchSchema>

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input)
    if (!result.success) throw new ValidationError('Dados inválidos', result.error.issues)
    return result.data
}

export const validateClaimDevice = (input: unknown): ClaimDeviceInput => parse(claimDeviceSchema, input)
export const validatePassageBatch = (input: unknown): PassageBatchInput => parse(passageBatchSchema, input)
