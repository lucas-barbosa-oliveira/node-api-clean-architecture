import type { TlsClientConfig, TlsServerConfig } from '../infrastructure/security/tls.ts'
import { readSecretFile, type Env, type SecretVar } from './env.ts'

/**
 * Valor atual de um segredo: relê o arquivo (<VAR>_FILE) a cada chamada, para a recarga pegar o valor novo;
 * sem arquivo, o valor da variável de ambiente.
 */
export function currentSecret(env: Env, name: SecretVar): string | undefined {
    const path = env.secretFiles[name]
    return path ? readSecretFile(path, name) : (env as unknown as Record<string, string | undefined>)[name]
}

/** Arquivos que, se mudarem, exigem reconfigurar a conexão: os segredos lidos de arquivo e os do TLS. */
export function watchedFiles(env: Env, secrets: SecretVar[], tls?: TlsClientConfig | TlsServerConfig): string[] {
    const files = secrets.map(name => env.secretFiles[name]).filter((path): path is string => Boolean(path))
    if (tls) files.push(...[tls.caFile, tls.certFile, tls.keyFile].filter((path): path is string => Boolean(path)))
    return [...new Set(files)]
}
