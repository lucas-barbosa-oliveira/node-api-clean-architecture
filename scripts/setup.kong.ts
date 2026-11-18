/**
 * Prepara a autenticação para rodar com o Kong:
 *  1. gera o par de chaves RSA dos JWTs (se ainda não existir);
 *  2. gera kong/kong.yml a partir de kong/kong.template.yml, com a chave pública e o emissor.
 *
 * Uso: npm run kong:setup (lê .env.docker). Rodado automaticamente por npm run docker:up e docker:infra.
 * KONG_UPSTREAM_URL: onde o Kong encontra a API (padrão: o container "api"; docker:infra usa o host).
 * Com https:// no KONG_UPSTREAM_URL (modo TLS), o Kong verifica o certificado da API com KONG_UPSTREAM_CA_FILE
 * (padrão ./certs/ca.crt) e se identifica com KONG_UPSTREAM_CLIENT_CERT_FILE/KEY_FILE (padrão ./certs/kong.crt|key),
 * para a API que exige certificado de cliente (SERVER_TLS_CLIENT_AUTH=require). Certificados: npm run tls:setup.
 * KONG_RATE_LIMIT_REDIS_HOST (e _PORT, _PASSWORD, _DATABASE): rate limit compartilhado no Redis (policy redis), para
 * várias instâncias do Kong somarem as mesmas contagens. Sem ele, cada Kong conta sozinho (policy local).
 * Chave dos JWTs: o Kong só precisa da pública. Ela só é gerada (junto com a privada) se não existir, como no modo
 * Vault, em que vem do próprio Vault (JWT_PUBLIC_KEY_PATH=.vault/jwt.public.pem).
 * Depois de trocar as chaves ou o template: npm run kong:setup && docker compose restart kong
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseDocument } from 'yaml'

const privateKeyPath = process.env.JWT_PRIVATE_KEY_PATH ?? './keys/jwt.private.pem'
const publicKeyPath = process.env.JWT_PUBLIC_KEY_PATH ?? './keys/jwt.public.pem'
const issuer = process.env.JWT_ISSUER ?? 'api-clean-architecture'
const upstreamUrl = process.env.KONG_UPSTREAM_URL ?? 'http://api:3000'

const TEMPLATE = 'kong/kong.template.yml'
const OUTPUT = 'kong/kong.yml'

if (!existsSync(publicKeyPath)) {
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

const upstreamTls = upstreamUrl.startsWith('https://')
const redisHost = process.env.KONG_RATE_LIMIT_REDIS_HOST
let output = upstreamTls ? await withUpstreamTls(rendered) : rendered
if (redisHost) output = withRedisRateLimit(output, redisHost)

const header = `# GERADO por scripts/setup.kong.ts a partir de ${TEMPLATE}. Não edite: altere o template.\n`
await writeFile(OUTPUT, header + output)
const tlsNote = (upstreamTls ? ', TLS verificado e certificado de cliente' : '')
    + (redisHost ? `, rate limit no Redis ${redisHost}` : ', rate limit local')
console.log(`[kong:setup] ${OUTPUT} gerado (emissor: ${issuer}, upstream: ${upstreamUrl}${tlsNote})`)

/** Kong -> API por HTTPS: confere o certificado da API contra a CA e apresenta o certificado do Kong (mTLS). */
async function withUpstreamTls(yaml: string): Promise<string> {
    const caFile = process.env.KONG_UPSTREAM_CA_FILE ?? './certs/ca.crt'
    const certFile = process.env.KONG_UPSTREAM_CLIENT_CERT_FILE ?? './certs/kong.crt'
    const keyFile = process.env.KONG_UPSTREAM_CLIENT_KEY_FILE ?? './certs/kong.key'
    for (const file of [caFile, certFile, keyFile]) {
        if (!existsSync(file)) throw new Error(`[kong:setup] ${file} não existe: rode npm run tls:setup`)
    }
    // no modo DB-less, as referências entre entidades são por id (gerado a cada execução; o Kong recarrega tudo)
    const caId = randomUUID()
    const certificateId = randomUUID()
    const doc = parseDocument(yaml)
    doc.setIn(['services', 0, 'tls_verify'], true)
    doc.setIn(['services', 0, 'ca_certificates'], [caId])
    doc.setIn(['services', 0, 'client_certificate'], certificateId)
    doc.set('ca_certificates', [{ id: caId, cert: (await readFile(caFile, 'utf8')).trim() }])
    doc.set('certificates', [{
        id: certificateId,
        cert: (await readFile(certFile, 'utf8')).trim(),
        key: (await readFile(keyFile, 'utf8')).trim(),
    }])
    return doc.toString({ lineWidth: 0 })
}

/**
 * Todos os plugins rate-limiting passam a contar no Redis: com várias réplicas do Kong, o limite vale para o conjunto
 * (com policy local, cada réplica teria o seu). Se o Redis cair, o Kong deixa passar (fault_tolerant) e registra.
 */
function withRedisRateLimit(yaml: string, host: string): string {
    const doc = parseDocument(yaml)
    const redis = {
        host,
        port: Number(process.env.KONG_RATE_LIMIT_REDIS_PORT ?? 6379),
        database: Number(process.env.KONG_RATE_LIMIT_REDIS_DATABASE ?? 1), // separado do BullMQ (banco 0)
        ...(process.env.KONG_RATE_LIMIT_REDIS_PASSWORD && { password: process.env.KONG_RATE_LIMIT_REDIS_PASSWORD }),
        timeout: 2000,
    }
    let count = 0
    const visit = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (!node || typeof node !== 'object') return
        const plugin = node as { name?: string; config?: Record<string, unknown> }
        if (plugin.name === 'rate-limiting' && plugin.config) {
            plugin.config.policy = 'redis'
            plugin.config.redis = redis
            plugin.config.fault_tolerant = true
            count++
        }
        Object.values(node).forEach(visit)
    }
    const json = doc.toJS() as unknown
    visit(json)
    if (count === 0) throw new Error('[kong:setup] nenhum plugin rate-limiting encontrado no template')
    const comments = yaml.match(/^(#.*\n)+/)?.[0] ?? ''
    return comments + new (doc.constructor as typeof import('yaml').Document)(json).toString({ lineWidth: 0 })
}
