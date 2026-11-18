/**
 * Ambiente local com Vault (docker-compose.yml + .tls.yml + .vault.yml), na mesma configuração que vai para o
 * Kubernetes: o módulo infra/vault aplicado pelo OpenTofu e o Vault Agent entregando arquivos à API.
 *
 *   node scripts/vault.local.ts up         tudo em containers         (npm run docker:up:vault)
 *   node scripts/vault.local.ts infra      dependências; API no host  (npm run docker:infra:vault + dev:docker:vault)
 *   node scripts/vault.local.ts bootstrap  só aplica o módulo no Vault que já está de pé (npm run vault:bootstrap)
 *
 * O Vault local roda em modo dev (em memória): a cada subida ele é recriado e o módulo, aplicado do zero. Por isso o
 * estado do OpenTofu fica em .vault/ e é descartado junto. Requer: Docker, OpenTofu (tofu) e Node.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const mode = process.argv[2] ?? 'up'
if (!['up', 'infra', 'bootstrap'].includes(mode)) {
    console.error('Uso: node scripts/vault.local.ts <up|infra|bootstrap>')
    process.exit(1)
}

const ROOT = resolve(import.meta.dirname, '..')
const VAULT_DIR = join(ROOT, '.vault')
const SECRETS_DIR = join(VAULT_DIR, 'secrets')
const TEMPLATES_SOURCE = join(ROOT, 'deploy/helm/api-clean-architecture/files/vault')
const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.tls.yml', '-f', 'docker-compose.vault.yml']
const VAULT_ENV = { VAULT_ADDR: 'http://127.0.0.1:8200', VAULT_TOKEN: 'dev-root-token' }
// o certificado da API é o último: o healthcheck do Agent espera por ele
const TEMPLATE_ORDER = [
    'mongo-username', 'mongo-password', 'rabbitmq-username', 'rabbitmq-password', 'redis-password', 'influx-token',
    'admin-password', 'jwt-private-key', 'jwt-public-key', 'ca-cert', 'api-cert',
]

const run = (command: string, args: string[], options: ExecFileSyncOptions = {}) => {
    console.log(`\n[vault] $ ${command} ${args.join(' ')}`)
    execFileSync(command, args, { stdio: 'inherit', cwd: ROOT, ...options, env: { ...process.env, ...options.env } })
}
/** Em caso de falha, mostra os logs dos serviços envolvidos (no terminal e no passo do CI) antes de sair. */
const compose = (...args: string[]) => {
    try {
        run('docker', [...COMPOSE, ...args])
    } catch (err) {
        const services = args.filter(arg => !arg.startsWith('-') && arg !== 'up')
        if (services.length > 0) {
            console.error(`\n[vault] falhou; últimas linhas de log de: ${services.join(', ')}`)
            try {
                const logs = [...COMPOSE, 'logs', '--no-color', '--tail', '80', ...services]
                execFileSync('docker', logs, { stdio: 'inherit', cwd: ROOT })
            } catch {
                // sem logs: o erro original continua valendo
            }
        }
        throw err
    }
}

try {
    execFileSync('tofu', ['version'], { stdio: 'ignore' })
} catch {
    console.error('[vault] OpenTofu (tofu) não encontrado: https://opentofu.org/docs/intro/install/')
    process.exit(1)
}

if (mode !== 'bootstrap') {
    // Vault novo (dev, em memória): tudo o que ele emitiu antes deixa de valer
    compose('up', '-d', '--force-recreate', '--wait', 'vault')
}

prepareDirectories()
renderAgentConfig()
applyModule()

if (mode === 'bootstrap') {
    console.log('\n[vault] módulo aplicado. Recrie os serviços para usarem os certificados novos (npm run docker:up:vault).')
    process.exit(0)
}

// serviços com certificados novos da PKI do Vault
compose('up', '-d', '--force-recreate', '--no-deps', '--wait', 'mongo', 'redis', 'influxdb', 'rabbitmq')
compose('up', '-d', '--force-recreate', '--no-deps', '--wait', 'vault-agent')

// índices fora da inicialização da API, como o job do deploy no Kubernetes
run('node', ['--env-file=.env.docker', '--env-file=.env.tls', '--env-file=.env.vault', 'src/main/migrate.ts'])

const upstream = mode === 'up' ? 'https://api:3000' : 'https://host.docker.internal:3000'
run('node', ['scripts/setup.kong.ts'], {
    env: { KONG_UPSTREAM_URL: upstream, JWT_PUBLIC_KEY_PATH: join(VAULT_DIR, 'jwt.public.pem') },
})

if (mode === 'up') compose('up', '-d', '--build', '--force-recreate', '--no-deps', '--wait', 'lgtm', 'api')
else compose('up', '-d', '--no-deps', '--wait', 'lgtm')
compose('up', '-d', '--force-recreate', '--no-deps', '--wait', 'kong')

console.log(`
[vault] pronto.
  Kong:        https://localhost:8443 (curl --cacert certs/ca.crt ...)
  Vault:       http://localhost:8200 (token dev-root-token)
  Segredos:    .vault/secrets (entregues pelo Vault Agent)${mode === 'infra' ? '\n  API:         npm run dev:docker:vault' : ''}`)

function prepareDirectories(): void {
    for (const dir of ['approle', 'templates', 'secrets']) mkdirSync(join(VAULT_DIR, dir), { recursive: true })
    // o Agent (em container, uid 1000) grava aqui; credenciais do Vault anterior não valem mais
    chmodSync(SECRETS_DIR, 0o777)
    for (const file of readdirSync(SECRETS_DIR)) rmSync(join(SECRETS_DIR, file), { force: true })
}

/** Templates do chart com os valores locais, e a configuração do Agent com um bloco template por arquivo. */
function renderAgentConfig(): void {
    const values: Record<string, string> = {
        API_CERT_COMMON_NAME: 'api',
        API_CERT_ALT_NAMES: 'api,localhost,host.docker.internal',
        API_CERT_IP_SANS: '127.0.0.1',
        API_CERT_TTL: '24h',
        SECRETS_DIR: '/vault/secrets',
        // só no ambiente local: a API no host (ou os testes no CI) pode rodar com outro uid que não o do Agent
        KEY_PERMS: '0644',
    }
    const blocks: string[] = []
    for (const name of TEMPLATE_ORDER) {
        const source = readFileSync(join(TEMPLATES_SOURCE, `${name}.ctmpl`), 'utf8')
        const rendered = source.replace(/@@(\w+)@@/g, (match, key: string) => {
            if (!(key in values)) throw new Error(`Marcador sem valor em ${name}.ctmpl: ${match}`)
            return values[key]
        })
        writeFileSync(join(VAULT_DIR, 'templates', `${name}.ctmpl`), rendered)
        blocks.push([
            'template {',
            `  source      = "/vault/templates/${name}.ctmpl"`,
            `  destination = "/vault/secrets/${name}"`,
            '  perms       = "0644" # local: legível pela API no host; no Kubernetes, 0600',
            '}',
        ].join('\n'))
    }
    const base = readFileSync(join(ROOT, 'deploy/vault-agent/agent.local.hcl'), 'utf8')
    writeFileSync(join(VAULT_DIR, 'agent.hcl'), `${base}\n# gerado por scripts/vault.local.ts\n${blocks.join('\n\n')}\n`)
}

function applyModule(): void {
    const state = join(VAULT_DIR, 'local.tfstate')
    // estado do Vault anterior (que já não existe): começa do zero
    for (const file of [state, `${state}.backup`]) if (existsSync(file)) rmSync(file)
    const env = { ...VAULT_ENV, TF_DATA_DIR: join(VAULT_DIR, 'tofu'), TF_IN_AUTOMATION: '1' }
    run('tofu', ['-chdir=infra/vault', 'init', '-input=false'], { env })
    run('tofu', [
        '-chdir=infra/vault', 'apply', '-auto-approve', '-input=false', '-lock=false',
        `-state=${state}`, '-var-file=envs/local.tfvars',
    ], { env })
}
