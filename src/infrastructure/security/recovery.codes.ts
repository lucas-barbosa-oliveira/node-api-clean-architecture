import { createHash, randomInt } from 'node:crypto'
import type { IRecoveryCodes } from '../../application/port/recovery.codes.ts'

/** Sem 0/O, 1/I/L: o usuário copia o código de um papel sem confundir caracteres. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const LENGTH = 16
const FORMAT = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`)

/**
 * 16 caracteres de 31 possíveis (~79 bits), no formato XXXX-XXXX-XXXX-XXXX. Com essa entropia, um SHA-256 basta para
 * guardar (como o refresh token): não dá para descobrir os códigos a partir dos hashes por tentativa e erro.
 */
export class RecoveryCodes implements IRecoveryCodes {
    public generate(count: number): { codes: string[]; hashes: string[] } {
        const codes = Array.from({ length: count }, () => {
            const raw = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
            return raw.match(/.{4}/g)?.join('-') ?? raw
        })
        return { codes, hashes: codes.map(code => this.hash(code) as string) }
    }

    public hash(code: string): string | null {
        const normalized = code.toUpperCase().replace(/[\s-]/g, '')
        if (!FORMAT.test(normalized)) return null
        return createHash('sha256').update(normalized).digest('base64url')
    }
}
