import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readTlsClientOptions, type TlsClientConfig, type TlsClientOptions } from '../security/tls.ts'

/** Vault (ou o Agent) fora do ar: vira 503 com Retry-After, como as demais dependências. */
export class VaultUnavailableError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options)
        this.name = 'VaultUnavailableError'
    }
}

export type VaultClientConfig = {
    /** Vault ou Vault Agent (no Kubernetes, http://127.0.0.1:8100: o Agent já autentica e injeta o token). */
    address: string;
    /** Arquivo com o token (sink do Agent), relido a cada chamada: o Agent renova e troca o arquivo. */
    tokenFile?: string;
    namespace?: string;
    tls?: TlsClientConfig;
    timeoutMs?: number;
}

/** Cliente HTTP mínimo da API do Vault (só o que a aplicação usa), sem dependências. */
export class VaultClient {
    #config: VaultClientConfig
    #tls?: TlsClientOptions

    constructor(config: VaultClientConfig) {
        this.#config = config
        this.#tls = config.tls && readTlsClientOptions(config.tls)
    }

    public async read<T>(path: string): Promise<T> {
        return this.#call<T>('GET', path)
    }

    public async write<T>(path: string, body: unknown): Promise<T> {
        return this.#call<T>('POST', path, body)
    }

    async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
        const token = this.#config.tokenFile ? (await readFile(this.#config.tokenFile, 'utf8')).trim() : undefined
        const url = new URL(`/v1/${path.replace(/^\/+/, '')}`, this.#config.address)
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
        const request = url.protocol === 'https:' ? httpsRequest : httpRequest
        return new Promise<T>((resolve, reject) => {
            const req = request(url, {
                method,
                timeout: this.#config.timeoutMs ?? 3000,
                headers: {
                    ...(token && { 'X-Vault-Token': token }),
                    ...(this.#config.namespace && { 'X-Vault-Namespace': this.#config.namespace }),
                    ...(payload && { 'Content-Type': 'application/json', 'Content-Length': payload.length }),
                },
                ...this.#tls,
            }, res => {
                const chunks: Buffer[] = []
                res.on('data', chunk => chunks.push(chunk as Buffer))
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8')
                    const status = res.statusCode ?? 0
                    const json = text ? safeJson(text) : {}
                    if (status >= 200 && status < 300) return resolve(json as T)
                    const errors = (json as { errors?: string[] }).errors?.join('; ') || text.slice(0, 200)
                    // 5xx/429: o Vault (ou o Agent) está com problema, não a requisição
                    const ErrorType = status >= 500 || status === 429 ? VaultUnavailableError : Error
                    reject(new ErrorType(`Vault ${method} ${path}: HTTP ${status}${errors ? ` (${errors})` : ''}`))
                })
            })
            req.on('timeout', () => req.destroy(new Error('sem resposta em 3s')))
            req.on('error', err => reject(new VaultUnavailableError(`Vault indisponível: ${err.message}`, { cause: err })))
            req.end(payload)
        })
    }
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return {}
    }
}
