/**
 * Copia os módulos do Vault da plataforma (platform-infra/vault/modules) para dev/vault/modules, usados pelo Vault
 * local. Fonte: PLATFORM_INFRA_DIR ou ../platform-infra. Uso: npm run vault:sync-modules
 */
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const platform = resolve(process.env.PLATFORM_INFRA_DIR ?? join(import.meta.dirname, '../../platform-infra'))
const source = join(platform, 'vault/modules')
const target = resolve(import.meta.dirname, '../dev/vault/modules')
if (!existsSync(source)) {
    console.error(`[vault] módulos não encontrados em ${source} (defina PLATFORM_INFRA_DIR)`)
    process.exit(1)
}
for (const module of ['root-pki', 'environment', 'service']) {
    rmSync(join(target, module), { recursive: true, force: true })
    cpSync(join(source, module), join(target, module), { recursive: true })
}
console.log(`[vault] módulos sincronizados de ${source}`)
