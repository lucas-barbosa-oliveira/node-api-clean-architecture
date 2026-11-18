import { createServer as createHttpServer, type RequestListener, type Server } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { ILogger } from '../application/port/logger.ts'
import { readTlsServerOptions, type TlsServerConfig } from '../infrastructure/security/tls.ts'

/** Servidor só de saúde, em HTTP (HEALTH_PORT): as probes do kubelet não apresentam certificado de cliente. */
export function startHealthServer(app: RequestListener, options: { port: number; logger: ILogger }): Server {
    return createHttpServer(app).listen(options.port, () => {
        options.logger.info(`Health checks em HTTP na porta ${options.port} (/health, /health/live, /health/ready)`)
    })
}

export type HttpServer = {
    server: Server;
    /** Relê certificado e chave do disco (renovação sem reiniciar). Só com TLS. */
    reloadTls?(): void;
}

/**
 * Sobe o servidor da API em HTTP ou, com SERVER_TLS=true, em HTTPS (com mTLS opcional).
 * Certificado ausente ou inválido derruba a inicialização: melhor do que subir em HTTP sem avisar.
 */
export function startHttpServer(
    app: RequestListener,
    options: { port: number; tls?: TlsServerConfig; logger: ILogger },
): HttpServer {
    const { port, tls, logger } = options
    if (!tls) {
        const server = createHttpServer(app).listen(port, () => logger.info(`Servidor HTTP ouvindo na porta ${port}`))
        return { server }
    }

    const server: HttpsServer = createHttpsServer(readTlsServerOptions(tls), app)
    // handshake recusado (cliente sem certificado, versão antiga de TLS...): fica no log em debug, não derruba nada
    server.on('tlsClientError', (err, socket) => {
        logger.debug(`Handshake TLS recusado de ${socket.remoteAddress ?? '?'}: ${err.message}`)
    })
    server.listen(port, () => {
        const mtls = tls.clientAuth === 'require' ? ', certificado de cliente obrigatório' : ''
        logger.info(`Servidor HTTPS ouvindo na porta ${port} (${tls.minVersion} ou superior${mtls})`)
    })
    return {
        server,
        reloadTls: () => {
            // as conexões novas usam o certificado novo; as abertas seguem com o antigo até fechar
            server.setSecureContext(readTlsServerOptions(tls))
            logger.info(`Certificado TLS recarregado de ${tls.certFile}`)
        },
    }
}
