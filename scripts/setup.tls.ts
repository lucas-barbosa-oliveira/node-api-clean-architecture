/**
 * Gera os certificados do ambiente com TLS (docker-compose.tls.yml e .env.tls) em ./certs:
 *
 *   ca.crt / ca.key           CA local (a chave da CA não é montada em nenhum container)
 *   api.crt / api.key         servidor HTTPS da API e identidade dela como cliente (mTLS com Mongo, Redis, RabbitMQ)
 *   kong.crt / kong.key       proxy HTTPS do Kong (porta 8443) e certificado de cliente do Kong para a API (mTLS)
 *   mongo.pem                 mongod (certificado + chave num arquivo)
 *   redis, rabbitmq, influxdb .crt / .key de cada servidor
 *
 * Uso: npm run tls:setup [-- --force]   (requer openssl). Rodado automaticamente por docker:up:tls e docker:infra:tls.
 * Reaproveita os certificados existentes que valem por mais de 30 dias; --force gera tudo de novo.
 * Para o navegador e o curl confiarem no Kong: use certs/ca.crt (curl --cacert certs/ca.crt https://localhost:8443/...).
 */
import { generateCertificates, hasOpenSsl, type CertificateRequest } from './tls.certificates.ts'

const DIR = 'certs'
const local = { dnsNames: ['localhost'], ips: ['127.0.0.1'] }
const service = (name: string, extra: Partial<CertificateRequest> = {}): CertificateRequest => ({
    name,
    ...extra,
    dnsNames: [name, ...local.dnsNames, ...(extra.dnsNames ?? [])],
    ips: local.ips,
})

const requests: CertificateRequest[] = [
    // host.docker.internal: no modo docker:infra:tls o Kong acessa a API rodando no host por este nome
    service('api', { dnsNames: ['host.docker.internal'] }),
    service('kong'),
    service('mongo', { combinedPem: true }),
    service('redis'),
    service('rabbitmq'),
    service('influxdb'),
]

if (!hasOpenSsl()) {
    console.error('[tls:setup] openssl não encontrado: instale-o (apt install openssl / brew install openssl)')
    process.exit(1)
}

const { generated, kept } = generateCertificates(DIR, requests, {
    force: process.argv.includes('--force'),
    caName: 'api-clean-architecture local CA',
})
if (kept.length > 0) console.log(`[tls:setup] mantidos (válidos): ${kept.join(', ')}`)
if (generated.length > 0) console.log(`[tls:setup] gerados em ${DIR}/: ${generated.join(', ')}`)
