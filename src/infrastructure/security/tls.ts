import { readFileSync } from 'node:fs'
import type { ServerOptions } from 'node:https'
import type { ConnectionOptions } from 'node:tls'

/**
 * TLS de uma conexão de saída (API -> MongoDB, Redis, RabbitMQ, InfluxDB). Os campos são caminhos de arquivos PEM,
 * lidos na inicialização: arquivo ausente ou ilegível é erro de configuração e impede a API de subir.
 */
export type TlsClientConfig = {
    /** CA que assinou o certificado do servidor. Sem ela, valem as CAs do sistema (e NODE_EXTRA_CA_CERTS). */
    caFile?: string;
    /** Certificado e chave desta API, para servidores que exigem certificado de cliente (mTLS). */
    certFile?: string;
    keyFile?: string;
    /** Nome esperado no certificado do servidor (SNI), quando diferente do host da URL. */
    servername?: string;
    /** false aceita qualquer certificado do servidor: só para diagnóstico, nunca em produção. */
    rejectUnauthorized: boolean;
}

/** TLS do servidor HTTP da própria API. */
export type TlsServerConfig = {
    certFile: string;
    keyFile: string;
    /** CA dos certificados de cliente aceitos (obrigatória com clientAuth "require"). */
    caFile?: string;
    /** "require": só aceita conexões com certificado de cliente assinado pela CA (mTLS, ex.: só o Kong). */
    clientAuth: 'none' | 'require';
    minVersion: 'TLSv1.2' | 'TLSv1.3';
}

/** Opções aceitas por tls.connect: servem para mongodb, ioredis, amqplib e https.request (InfluxDB). */
export type TlsClientOptions = Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'servername' | 'rejectUnauthorized'>

export function readTlsClientOptions(config: TlsClientConfig): TlsClientOptions {
    return {
        ...(config.caFile && { ca: readPem(config.caFile, 'a CA') }),
        ...(config.certFile && { cert: readPem(config.certFile, 'o certificado de cliente') }),
        ...(config.keyFile && { key: readPem(config.keyFile, 'a chave do certificado de cliente') }),
        ...(config.servername && { servername: config.servername }),
        rejectUnauthorized: config.rejectUnauthorized,
    }
}

export function readTlsServerOptions(config: TlsServerConfig): ServerOptions {
    const requireClientCert = config.clientAuth === 'require'
    return {
        cert: readPem(config.certFile, 'o certificado do servidor'),
        key: readPem(config.keyFile, 'a chave do certificado do servidor'),
        ...(config.caFile && { ca: readPem(config.caFile, 'a CA dos clientes') }),
        minVersion: config.minVersion,
        // com requestCert + rejectUnauthorized, o handshake falha sem certificado válido: nem chega ao Express
        requestCert: requireClientCert,
        rejectUnauthorized: requireClientCert,
    }
}

/** Resumo para os logs de conexão: " com TLS (CA própria, certificado de cliente)". */
export function describeTls(config: TlsClientConfig | undefined): string {
    if (!config) return ''
    const details = [
        config.caFile ? `CA ${config.caFile}` : 'CAs do sistema',
        ...(config.certFile ? ['certificado de cliente'] : []),
        ...(config.rejectUnauthorized ? [] : ['SEM verificar o certificado do servidor']),
    ]
    return ` com TLS (${details.join(', ')})`
}

function readPem(path: string, what: string): Buffer {
    try {
        return readFileSync(path)
    } catch (err) {
        throw new Error(`TLS: não foi possível ler ${what} em ${path}: ${(err as Error).message}`, { cause: err })
    }
}
