import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import type { IPasswordHasher } from '../../application/port/password.hasher.ts'

const KEY_LENGTH = 64
const DEFAULTS = { N: 16_384, r: 8, p: 1 }

const derive = (password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        scrypt(password, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)))
    })

/**
 * Hash de senha com scrypt (nativo do Node). Formato: scrypt$N$r$p$salt$hash (base64).
 * Os parâmetros ficam no próprio hash, então dá para aumentá-los no futuro sem invalidar senhas antigas.
 */
export class ScryptPasswordHasher implements IPasswordHasher {
    public async hash(password: string): Promise<string> {
        const salt = randomBytes(16)
        const key = await derive(password, salt, DEFAULTS)
        const { N, r, p } = DEFAULTS
        return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$')
    }

    public async verify(password: string, stored: string): Promise<boolean> {
        const [algorithm, N, r, p, salt, key] = stored.split('$')
        if (algorithm !== 'scrypt' || !salt || !key) return false
        const expected = Buffer.from(key, 'base64')
        const actual = await derive(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p) })
        return actual.length === expected.length && timingSafeEqual(actual, expected)
    }
}
