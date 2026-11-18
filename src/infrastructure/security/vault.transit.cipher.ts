import type { ISecretCipher } from '../../application/port/secret.cipher.ts'
import type { VaultClient } from '../vault/vault.client.ts'
import { AesSecretCipher } from './aes.secret.cipher.ts'

const KEY_VERSION_TTL_MS = 60_000

/**
 * Cifra pelo motor Transit do Vault: a chave nunca sai do Vault, e a aplicação só pede "cifre" e "decifre".
 * Formato vault:v<versão>:<cifrado>. Com a chave rotacionada no Vault, o próximo uso faz "rewrap" (o Vault cifra de
 * novo com a versão atual sem devolver o texto aberto).
 *
 * Migração de MFA_CIPHER=local: com MFA_ENCRYPTION_KEY ainda definida, os segredos no formato antigo (v1.<kid>...)
 * continuam legíveis e passam para o Transit no próximo uso.
 */
export class VaultTransitCipher implements ISecretCipher {
    #vault: VaultClient
    #mount: string
    #key: string
    #legacy?: AesSecretCipher
    #latest?: { version: number; at: number }

    constructor(deps: { vault: VaultClient; mount: string; key: string; legacy?: AesSecretCipher }) {
        this.#vault = deps.vault
        this.#mount = deps.mount
        this.#key = deps.key
        this.#legacy = deps.legacy
    }

    public async encrypt(plaintext: string): Promise<string> {
        const res = await this.#vault.write<{ data: { ciphertext: string } }>(
            `${this.#mount}/encrypt/${this.#key}`,
            { plaintext: Buffer.from(plaintext, 'utf8').toString('base64') },
        )
        return res.data.ciphertext
    }

    public async decrypt(sealed: string): Promise<string> {
        if (AesSecretCipher.owns(sealed)) {
            if (!this.#legacy) throw new Error('Segredo no formato local: defina MFA_ENCRYPTION_KEY durante a migração')
            return this.#legacy.decrypt(sealed)
        }
        const res = await this.#vault.write<{ data: { plaintext: string } }>(
            `${this.#mount}/decrypt/${this.#key}`,
            { ciphertext: sealed },
        )
        return Buffer.from(res.data.plaintext, 'base64').toString('utf8')
    }

    public async refresh(sealed: string): Promise<string | null> {
        if (AesSecretCipher.owns(sealed)) return this.encrypt(await this.decrypt(sealed))
        const version = Number(/^vault:v(\d+):/.exec(sealed)?.[1] ?? 0)
        if (version >= await this.#latestVersion()) return null
        const res = await this.#vault.write<{ data: { ciphertext: string } }>(
            `${this.#mount}/rewrap/${this.#key}`,
            { ciphertext: sealed },
        )
        return res.data.ciphertext
    }

    /** Também serve de verificação de saúde: confere acesso à chave. */
    public async latestVersion(): Promise<number> {
        return this.#latestVersion(true)
    }

    async #latestVersion(force = false): Promise<number> {
        if (!force && this.#latest && Date.now() - this.#latest.at < KEY_VERSION_TTL_MS) return this.#latest.version
        const res = await this.#vault.read<{ data: { latest_version: number } }>(`${this.#mount}/keys/${this.#key}`)
        this.#latest = { version: res.data.latest_version, at: Date.now() }
        return this.#latest.version
    }
}
