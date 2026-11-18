/**
 * Gera uma CA local e certificados assinados por ela (openssl), para o ambiente com TLS.
 * Usado por scripts/setup.tls.ts e pelos testes. Somente desenvolvimento: em produção, os certificados vêm da sua
 * PKI (Vault, cert-manager, ACM...) e a chave da CA nunca fica na mesma máquina dos serviços.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type CertificateRequest = {
    /** Nome do arquivo (<name>.crt / <name>.key) e Common Name. */
    name: string;
    /** Nomes DNS e IPs pelos quais o serviço é acessado (o cliente confere o host contra esta lista). */
    dnsNames: string[];
    ips?: string[];
    /** Também gera <name>.pem (certificado + chave num arquivo só, formato exigido pelo mongod). */
    combinedPem?: boolean;
}

export type GenerateResult = { generated: string[]; kept: string[] }

const CA_DAYS = 3650
const LEAF_DAYS = 825 // limite aceito pelos navegadores e pelo macOS para certificados de servidor
const RENEW_BEFORE_SECONDS = 30 * 86_400

export function hasOpenSsl(): boolean {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' })
        return true
    } catch {
        return false
    }
}

/**
 * Cria (ou reaproveita) dir/ca.crt + dir/ca.key e um certificado por pedido. Reaproveita o que já existe e ainda vale
 * por mais de 30 dias; force regenera tudo. Os certificados servem para servidor e cliente (serverAuth + clientAuth).
 */
export function generateCertificates(
    dir: string,
    requests: CertificateRequest[],
    options: { force?: boolean; caName?: string } = {},
): GenerateResult {
    mkdirSync(dir, { recursive: true })
    const work = mkdtempSync(join(tmpdir(), 'tls-'))
    const result: GenerateResult = { generated: [], kept: [] }
    try {
        const caCrt = join(dir, 'ca.crt')
        const caKey = join(dir, 'ca.key')
        let caRenewed = false
        if (options.force || !isValid(caCrt) || !existsSync(caKey)) {
            const config = join(work, 'ca.cnf')
            writeFileSync(config, [
                '[req]', 'distinguished_name = dn', 'prompt = no', 'x509_extensions = v3_ca',
                '[dn]', `CN = ${options.caName ?? 'Local development CA'}`,
                '[v3_ca]',
                'basicConstraints = critical, CA:TRUE, pathlen:0',
                'keyUsage = critical, keyCertSign, cRLSign',
                'subjectKeyIdentifier = hash',
            ].join('\n'))
            openssl(['req', '-x509', '-new', '-nodes', ...ecKey(), '-keyout', caKey, '-out', caCrt,
                '-days', String(CA_DAYS), '-sha256', '-config', config])
            chmodSync(caKey, 0o600) // nunca montada em container: só assina
            caRenewed = true
            result.generated.push('ca')
        } else {
            result.kept.push('ca')
        }

        for (const request of requests) {
            const crt = join(dir, `${request.name}.crt`)
            const key = join(dir, `${request.name}.key`)
            if (!caRenewed && !options.force && isValid(crt) && existsSync(key) && signedBy(crt, caCrt)) {
                result.kept.push(request.name)
                continue
            }
            const csr = join(work, `${request.name}.csr`)
            const ext = join(work, `${request.name}.ext`)
            const san = [...request.dnsNames.map(name => `DNS:${name}`), ...(request.ips ?? []).map(ip => `IP:${ip}`)]
            writeFileSync(ext, [
                'basicConstraints = critical, CA:FALSE',
                'keyUsage = critical, digitalSignature, keyEncipherment',
                'extendedKeyUsage = serverAuth, clientAuth',
                `subjectAltName = ${san.join(', ')}`,
                'authorityKeyIdentifier = keyid',
            ].join('\n'))
            openssl(['req', '-new', '-nodes', ...ecKey(), '-keyout', key, '-out', csr, '-subj', `/CN=${request.name}`])
            const serial = `0x${randomBytes(16).toString('hex')}`
            openssl(['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-set_serial', serial,
                '-days', String(LEAF_DAYS), '-sha256', '-extfile', ext, '-out', crt])
            // legível por outros usuários: cada container roda com um uid diferente (mongodb, redis, rabbitmq...)
            chmodSync(key, 0o644)
            if (request.combinedPem) {
                const pem = readFileSync(crt, 'utf8') + readFileSync(key, 'utf8')
                writeFileSync(join(dir, `${request.name}.pem`), pem, { mode: 0o644 })
            }
            result.generated.push(request.name)
        }
        return result
    } finally {
        rmSync(work, { recursive: true, force: true })
    }
}

function ecKey(): string[] {
    // ECDSA P-256: geração instantânea e suportada por todos os serviços (Mongo, Redis, RabbitMQ, InfluxDB, Kong, Node)
    return ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1']
}

/** Existe e não expira nos próximos 30 dias. */
function isValid(crt: string): boolean {
    if (!existsSync(crt)) return false
    try {
        openssl(['x509', '-in', crt, '-noout', '-checkend', String(RENEW_BEFORE_SECONDS)])
        return true
    } catch {
        return false
    }
}

function signedBy(crt: string, caCrt: string): boolean {
    try {
        openssl(['verify', '-CAfile', caCrt, crt])
        return true
    } catch {
        return false
    }
}

function openssl(args: string[]): void {
    try {
        execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim()
        throw new Error(`openssl ${args[0]} falhou${stderr ? `: ${stderr}` : ''}`, { cause: err })
    }
}
