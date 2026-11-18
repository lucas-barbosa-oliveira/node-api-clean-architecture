import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'

/** Um componente que sabe se reconfigurar quando algum dos seus arquivos de segredo ou certificado muda. */
export type Reloadable = {
    /** Nome nos logs (ex.: "mongodb", "servidor HTTPS"). */
    name: string;
    files: string[];
    reload(): Promise<void>;
}

/**
 * Relê periodicamente os arquivos de segredos e certificados (entregues pelo Vault Agent, por um Secret do Kubernetes
 * ou pelo cert-manager) e reconfigura o componente quando o conteúdo muda.
 *
 * Compara o conteúdo, não a data: os volumes do Kubernetes trocam os arquivos por link simbólico, e o fs.watch não
 * enxerga isso com confiabilidade. Se a reconfiguração falhar (ex.: arquivo pela metade), tenta de novo no próximo
 * ciclo, e o componente continua com a configuração anterior.
 */
export class SecretFileWatcher {
    #items: { target: Reloadable; hash?: string }[] = []
    #log: ILogger
    #timer?: NodeJS.Timeout
    #running?: Promise<void>

    constructor(logger: ILogger = silentLogger) {
        this.#log = logger
    }

    public add(target: Reloadable): void {
        if (target.files.length > 0) this.#items.push({ target })
    }

    public get watching(): string[] {
        return this.#items.map(item => item.target.name)
    }

    /** Guarda o estado atual e passa a conferir a cada intervalo. */
    public async start(intervalMs: number): Promise<void> {
        if (intervalMs <= 0 || this.#items.length === 0) return
        for (const item of this.#items) item.hash = await fingerprint(item.target.files).catch(() => undefined)
        this.#timer = setInterval(() => void this.check(), intervalMs)
        this.#timer.unref()
        this.#log.info(`Recarga automática de segredos e certificados a cada ${intervalMs / 1000}s: ${this.watching.join(', ')}`)
    }

    /** Uma rodada de verificação (também usada nos testes). */
    public async check(): Promise<void> {
        this.#running ??= this.#checkAll().finally(() => {
            this.#running = undefined
        })
        return this.#running
    }

    public async stop(): Promise<void> {
        clearInterval(this.#timer)
        await this.#running
    }

    async #checkAll(): Promise<void> {
        for (const item of this.#items) {
            let hash: string
            try {
                hash = await fingerprint(item.target.files)
            } catch (err) {
                this.#log.warn(`Arquivos de ${item.target.name} ilegíveis no momento: ${(err as Error).message}`)
                continue
            }
            if (hash === item.hash) continue
            try {
                this.#log.info(`Segredos ou certificados de ${item.target.name} mudaram: reconfigurando`)
                await item.target.reload()
                item.hash = hash
            } catch (err) {
                this.#log.error(`Falha ao reconfigurar ${item.target.name}: a configuração anterior continua em uso`, { err })
            }
        }
    }
}

async function fingerprint(files: string[]): Promise<string> {
    const hash = createHash('sha256')
    for (const file of files) hash.update(file).update('\0').update(await readFile(file)).update('\0')
    return hash.digest('hex')
}
