import type { RequestHandler } from 'express'
import type { ILogger } from '../../application/port/logger.ts'

/**
 * Uma linha por requisição, no formato "combined" (o mesmo do morgan), com o tempo de resposta:
 *   ::ffff:172.18.0.7 - "POST /auth/login HTTP/1.1" 200 594 473.586 ms "https://app.exemplo.com/" "Mozilla/5.0 ..."
 * Rotas de verificação (ex.: /health, chamada pelo Docker a cada 10 s) e arquivos estáticos da documentação
 * saem só no nível debug (o caminho é comparado como prefixo).
 */
export function accessLog(logger: ILogger, options: { quietPaths?: readonly string[] } = {}): RequestHandler {
    const quiet = options.quietPaths ?? ['/health', '/reference/assets']
    const isQuiet = (path: string) => quiet.some(prefix => path === prefix || path.startsWith(prefix + '/'))
    return (req, res, next) => {
        const start = process.hrtime.bigint()
        res.on('finish', () => {
            const ms = Number(process.hrtime.bigint() - start) / 1e6
            const size = res.get('Content-Length') ?? '-'
            const referer = req.get('Referer') ?? '-'
            const agent = req.get('User-Agent') ?? '-'
            const line = `${req.ip} - "${req.method} ${req.originalUrl} HTTP/${req.httpVersion}" ${res.statusCode} `
                + `${size} ${ms.toFixed(3)} ms "${referer}" "${agent}"`
            if (isQuiet(req.path)) logger.debug(line)
            else logger.info(line)
        })
        next()
    }
}
