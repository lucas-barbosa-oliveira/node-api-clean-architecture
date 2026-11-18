import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ITotp } from '../../application/port/totp.ts'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const PERIOD_SECONDS = 30
const DIGITS = 6
/** Passos aceitos para cada lado do atual: ±30 s de diferença de relógio entre o celular e o servidor. */
const WINDOW = 1
/** 160 bits: o tamanho recomendado para HMAC-SHA1 (RFC 4226). */
const SECRET_BYTES = 20

/**
 * TOTP (RFC 6238) com HMAC-SHA1, 6 dígitos e 30 s: os parâmetros que todos os aplicativos autenticadores suportam.
 * Implementado com node:crypto, sem dependências.
 */
export class Totp implements ITotp {
    public generateSecret(): string {
        return base32Encode(randomBytes(SECRET_BYTES))
    }

    public verify(secret: string, code: string, now = new Date()): number | null {
        const digits = code.replace(/\s/g, '')
        if (!/^\d{6}$/.test(digits)) return null
        const key = base32Decode(secret)
        const current = stepAt(now)
        let matched: number | null = null
        // compara todas as janelas (sem sair no primeiro acerto): o tempo de resposta não revela qual conferiu
        for (let offset = -WINDOW; offset <= WINDOW; offset++) {
            const step = current + offset
            if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(digits)) && matched === null) matched = step
        }
        return matched
    }

    public keyUri({ secret, account, issuer }: { secret: string; account: string; issuer: string }): string {
        const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
        const params = new URLSearchParams({
            secret,
            issuer,
            algorithm: 'SHA1',
            digits: String(DIGITS),
            period: String(PERIOD_SECONDS),
        })
        return `otpauth://totp/${label}?${params.toString()}`
    }

    /** Código de um instante (testes e diagnóstico). */
    public codeAt(secret: string, at = new Date()): string {
        return hotp(base32Decode(secret), stepAt(at))
    }
}

const stepAt = (date: Date) => Math.floor(date.getTime() / 1000 / PERIOD_SECONDS)

/** HOTP (RFC 4226): HMAC do contador, truncamento dinâmico e os últimos DIGITS dígitos. */
export function hotp(key: Buffer, counter: number, digits = DIGITS): string {
    const message = Buffer.alloc(8)
    message.writeBigUInt64BE(BigInt(counter))
    const hmac = createHmac('sha1', key).update(message).digest()
    const offset = hmac[hmac.length - 1] & 0x0f
    const binary = (hmac.readUInt32BE(offset) & 0x7f_ff_ff_ff) % 10 ** digits
    return String(binary).padStart(digits, '0')
}

export function base32Encode(data: Buffer): string {
    let bits = 0
    let value = 0
    let output = ''
    for (const byte of data) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 5) {
            output += BASE32[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
    return output
}

export function base32Decode(text: string): Buffer {
    const clean = text.toUpperCase().replace(/[\s=-]/g, '')
    let bits = 0
    let value = 0
    const bytes: number[] = []
    for (const char of clean) {
        const index = BASE32.indexOf(char)
        if (index < 0) throw new Error('Segredo TOTP com caractere fora do base32')
        value = (value << 5) | index
        bits += 5
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return Buffer.from(bytes)
}
