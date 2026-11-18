/**
 * HEALTHCHECK da imagem Docker: GET /health no próprio container, em HTTP ou HTTPS conforme SERVER_TLS.
 *
 * Com TLS, não verifica o certificado (a conexão é com 127.0.0.1, dentro do container, e o certificado é emitido para
 * o nome do serviço). Com SERVER_TLS_CLIENT_AUTH=require, apresenta o próprio certificado do servidor como certificado
 * de cliente: ele precisa ter os usos serverAuth e clientAuth (os gerados por npm run tls:setup têm).
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const port = Number(process.env.PORT ?? 3000)
const tls = process.env.SERVER_TLS === 'true'
const mtls = tls && process.env.SERVER_TLS_CLIENT_AUTH === 'require'

const request = tls ? httpsRequest : httpRequest
const req = request(
    {
        host: '127.0.0.1',
        port,
        path: '/health',
        timeout: 2500,
        ...(tls && { rejectUnauthorized: false }),
        ...(mtls && {
            cert: readFileSync(process.env.SERVER_TLS_CERT_FILE as string),
            key: readFileSync(process.env.SERVER_TLS_KEY_FILE as string),
        }),
    },
    res => process.exit(res.statusCode === 200 ? 0 : 1),
)
req.on('timeout', () => req.destroy())
req.on('error', () => process.exit(1))
req.end()
