import type { ILogger } from '../../application/port/logger.ts'

export type RetryOptions = {
    /** Nome do recurso nos logs, ex.: "MongoDB". */
    name: string;
    logger: ILogger;
    /** Espera antes da 2ª tentativa; dobra a cada falha até maxDelayMs. */
    initialDelayMs?: number;
    maxDelayMs?: number;
    /** 0 = tenta para sempre (padrão). */
    maxAttempts?: number;
    /** Interrompe as tentativas (ex.: SIGTERM durante a inicialização). */
    signal?: AbortSignal;
}

/**
 * Executa connect() até conseguir, registrando cada tentativa que falha.
 * Usado na inicialização: a aplicação só aceita tráfego depois que as dependências essenciais respondem.
 */
export async function retryUntilConnected<T>(connect: () => Promise<T>, options: RetryOptions): Promise<T> {
    const { name, logger, initialDelayMs = 1000, maxDelayMs = 15_000, maxAttempts = 0, signal } = options
    let delay = initialDelayMs
    for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted()
        if (attempt > 1) logger.info(`Tentativa ${attempt} de conexão com ${name}...`)
        try {
            return await connect()
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            if (maxAttempts > 0 && attempt >= maxAttempts) {
                logger.error(`Não foi possível conectar a ${name} após ${attempt} tentativa(s): ${reason}`)
                throw err
            }
            logger.warn(`Falha ao conectar a ${name} (tentativa ${attempt}): ${reason}. Nova tentativa em ${formatMs(delay)}`)
            await sleep(delay, signal)
            delay = Math.min(delay * 2, maxDelayMs)
        }
    }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal?.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export function formatMs(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`
}

/** Esconde usuário e senha de uma URI de conexão antes de logar (amqp://app:senha@host -> amqp://***@host). */
export function redactUri(uri: string): string {
    try {
        const url = new URL(uri)
        if (url.username || url.password) {
            url.username = '***'
            url.password = ''
        }
        return url.toString().replace('***:@', '***@')
    } catch {
        return '<uri inválida>'
    }
}
