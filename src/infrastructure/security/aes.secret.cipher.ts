import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { ISecretCipher } from '../../application/port/secret.cipher.ts'

const ALGORITHM = 'aes-256-gcm'
const VERSION = 'v1'

/**
 * AES-256-GCM (cifra autenticada: adulteração é detectada). Formato: v1.<kid>.<iv>.<tag>.<cifrado>, em base64url.
 * O kid identifica a chave: com MFA_ENCRYPTION_PREVIOUS_KEYS, segredos cifrados com chaves antigas continuam legíveis
 * e são cifrados de novo com a atual no próximo uso (rotação sem migração).
 */
export class AesSecretCipher implements ISecretCipher {
    #current: { kid: string; key: Buffer }
    #keys: Map<string, Buffer>

    constructor(currentKey: Buffer, previousKeys: Buffer[] = []) {
        for (const key of [currentKey, ...previousKeys]) {
            if (key.length !== 32) throw new Error('A chave de cifra do MFA precisa ter 32 bytes (openssl rand -base64 32)')
        }
        this.#current = { kid: keyId(currentKey), key: currentKey }
        this.#keys = new Map([currentKey, ...previousKeys].map(key => [keyId(key), key]))
    }

    public async encrypt(plaintext: string): Promise<string> {
        return this.encryptSync(plaintext)
    }

    public async decrypt(sealed: string): Promise<string> {
        return this.decryptSync(sealed)
    }

    public async refresh(sealed: string): Promise<string | null> {
        return this.isCurrent(sealed) ? null : this.encryptSync(this.decryptSync(sealed))
    }

    /** Formato desta cifra (para quem migra de MFA_CIPHER=local para vault-transit). */
    public static owns(sealed: string): boolean {
        return sealed.startsWith(`${VERSION}.`)
    }

    public encryptSync(plaintext: string): string {
        const iv = randomBytes(12)
        const cipher = createCipheriv(ALGORITHM, this.#current.key, iv)
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
        const parts = [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url'))
        return [VERSION, this.#current.kid, ...parts].join('.')
    }

    public decryptSync(sealed: string): string {
        const [version, kid, iv, tag, encrypted] = sealed.split('.')
        if (version !== VERSION || !kid || !iv || !tag || encrypted === undefined) throw new Error('Segredo cifrado inválido')
        const key = this.#keys.get(kid)
        if (!key) {
            throw new Error(`Segredo cifrado com uma chave desconhecida (${kid}): mantenha a chave anterior em `
                + 'MFA_ENCRYPTION_PREVIOUS_KEYS durante a rotação')
        }
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'))
        decipher.setAuthTag(Buffer.from(tag, 'base64url'))
        return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
    }

    public isCurrent(sealed: string): boolean {
        return sealed.split('.')[1] === this.#current.kid
    }
}

/** Primeiros 8 caracteres do SHA-256 da chave: identifica sem revelar. */
const keyId = (key: Buffer) => createHash('sha256').update(key).digest('base64url').slice(0, 8)
