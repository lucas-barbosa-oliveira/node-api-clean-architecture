/**
 * Prepara a autenticação para rodar com o Kong:
 *  1. gera o par de chaves RSA dos JWTs (se ainda não existir);
 *  2. gera kong/kong.yml a partir de kong/kong.template.yml, com a chave pública e o emissor.
 *
 * Uso: npm run kong:setup (lê .env.docker). Rodado automaticamente por npm run docker:up e docker:infra.
 * KONG_UPSTREAM_URL: onde o Kong encontra a API (padrão: o container "api"; docker:infra usa o host).
 * Depois de trocar as chaves ou o template: npm run kong:setup && docker compose restart kong
 */
import { generateKeyPairSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const privateKeyPath = process.env.JWT_PRIVATE_KEY_PATH ?? './keys/jwt.private.pem'
const publicKeyPath = process.env.JWT_PUBLIC_KEY_PATH ?? './keys/jwt.public.pem'
const issuer = process.env.JWT_ISSUER ?? 'api-clean-architecture'
const upstreamUrl = process.env.KONG_UPSTREAM_URL ?? 'http://api:3000'

const TEMPLATE = 'kong/kong.template.yml'
const OUTPUT = 'kong/kong.yml'

if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 3072,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    await mkdir(dirname(privateKeyPath), { recursive: true })
    await mkdir(dirname(publicKeyPath), { recursive: true })
    await writeFile(privateKeyPath, privateKey, { mode: 0o600 })
    await writeFile(publicKeyPath, publicKey, { mode: 0o644 })
    console.log(`[kong:setup] par de chaves gerado em ${privateKeyPath} e ${publicKeyPath}`)
} else {
    console.log('[kong:setup] usando as chaves existentes')
}

const publicKey = (await readFile(publicKeyPath, 'utf8')).trim()
const tracesEndpoint = process.env.KONG_OTEL_TRACES_ENDPOINT ?? 'http://lgtm:4318/v1/traces'
const values: Record<string, string> = {
    JWT_ISSUER: issuer,
    KONG_UPSTREAM_URL: upstreamUrl,
    KONG_OTEL_TRACES_ENDPOINT: tracesEndpoint,
}

const rendered = (await readFile(TEMPLATE, 'utf8'))
    // a chave PEM tem várias linhas: cada uma recebe a indentação do placeholder (bloco literal do YAML)
    .replace(/^([ \t]*)\$\{\{ JWT_PUBLIC_KEY \}\}$/m, (_match, indent: string) =>
        publicKey.split('\n').map(line => indent + line).join('\n'))
    .replace(/\$\{\{ (\w+) \}\}/g, (match, name: string) => {
        if (!(name in values)) throw new Error(`Placeholder sem valor em ${TEMPLATE}: ${match}`)
        return values[name]
    })

const header = `# GERADO por scripts/setup.kong.ts a partir de ${TEMPLATE}. Não edite: altere o template.\n`
await writeFile(OUTPUT, header + rendered)
console.log(`[kong:setup] ${OUTPUT} gerado (emissor: ${issuer}, upstream: ${upstreamUrl})`)
