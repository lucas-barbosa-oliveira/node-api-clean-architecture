import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { silentLogger, type ILogger } from '../../application/port/logger.ts'

export type SigningKeys = { privateKey: KeyObject; publicKey: KeyObject }

/**
 * Carrega o par de chaves RSA usado para assinar (privada) e validar (pública) os JWTs.
 * Sem caminhos configurados, gera um par temporário: os tokens deixam de valer ao reiniciar
 * e o Kong não conseguiria validá-los. Serve só para desenvolvimento rápido e testes.
 */
export async function loadSigningKeys(
    paths: { privateKeyPath?: string; publicKeyPath?: string },
    logger: ILogger = silentLogger,
): Promise<SigningKeys> {
    if (paths.privateKeyPath && paths.publicKeyPath) {
        const [privatePem, publicPem] = await Promise.all([readFile(paths.privateKeyPath), readFile(paths.publicKeyPath)])
        logger.info(`Chaves JWT carregadas de ${paths.privateKeyPath} e ${paths.publicKeyPath}`)
        return { privateKey: createPrivateKey(privatePem), publicKey: createPublicKey(publicPem) }
    }
    logger.warn('JWT_PRIVATE_KEY_PATH/JWT_PUBLIC_KEY_PATH não definidos: usando chaves temporárias (só desenvolvimento)')
    return generateKeyPairSync('rsa', { modulusLength: 2048 })
}
