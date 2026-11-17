import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import express, { Router } from 'express'
import { stringify } from 'yaml'
import type { OpenApiDocument } from './document.ts'

export const DOCS_PATH = '/reference'

/** Arquivos do Swagger UI vêm do pacote swagger-ui-dist (sem CDN: funciona offline e na rede interna). */
const swaggerUiDir = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'))

/**
 *   GET /reference                 Swagger UI (documentação navegável e "Try it out")
 *   GET /reference/openapi.json    documento OpenAPI 3.1
 *   GET /reference/openapi.yaml    o mesmo, em YAML
 */
export function docsRoutes(document: OpenApiDocument): Router {
    const json = JSON.stringify(document)
    const yaml = stringify(document, { aliasDuplicateObjects: false })
    const router = Router()

    router.get(`${DOCS_PATH}/openapi.json`, (_req, res) => {
        res.type('application/json').send(json)
    })
    router.get(`${DOCS_PATH}/openapi.yaml`, (_req, res) => {
        res.type('application/yaml').send(yaml)
    })
    router.get(`${DOCS_PATH}/init.js`, (_req, res) => {
        res.type('application/javascript').send(INIT_SCRIPT)
    })
    router.use(`${DOCS_PATH}/assets`, express.static(swaggerUiDir, { index: false, maxAge: '1d' }))
    router.get(DOCS_PATH, (_req, res) => {
        res.type('html').send(page(document.info.title))
    })
    return router
}

const page = (title: string) => `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — referência</title>
  <link rel="icon" type="image/png" href="${DOCS_PATH}/assets/favicon-32x32.png">
  <link rel="stylesheet" href="${DOCS_PATH}/assets/swagger-ui.css">
  <style>body { margin: 0; } .swagger-ui .topbar { display: none; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${DOCS_PATH}/assets/swagger-ui-bundle.js"></script>
  <script src="${DOCS_PATH}/init.js"></script>
</body>
</html>`

/**
 * Configuração do Swagger UI para testes rápidos:
 *  - "Try it out" já aberto e duração de cada chamada;
 *  - o access_token de login, refresh e pareamento é aplicado sozinho em "Authorize" (e removido no logout);
 *  - a autorização sobrevive ao recarregar a página (persistAuthorization).
 */
const INIT_SCRIPT = `
const TOKEN_ROUTES = /\\/(auth\\/login|auth\\/refresh|devices\\/claim)$/
// as variantes *WithPersistOption gravam no localStorage (persistAuthorization): o token sobrevive ao recarregar
const authorize = token => window.ui.authActions.authorizeWithPersistOption({
  bearerAuth: { name: 'bearerAuth', schema: { type: 'http', scheme: 'bearer' }, value: token },
})
window.ui = SwaggerUIBundle({
  url: '${DOCS_PATH}/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  persistAuthorization: true,
  tryItOutEnabled: true,
  displayRequestDuration: true,
  filter: true,
  docExpansion: 'list',
  defaultModelsExpandDepth: 0,
  showExtensions: true,
  presets: [SwaggerUIBundle.presets.apis],
  plugins: [SwaggerUIBundle.plugins.DownloadUrl],
  layout: 'BaseLayout',
  responseInterceptor: response => {
    try {
      const path = new URL(response.url, location.href).pathname
      if (response.ok && TOKEN_ROUTES.test(path)) {
        const body = typeof response.body === 'object' && response.body ? response.body : JSON.parse(response.text)
        if (body.access_token) authorize(body.access_token)
      }
      if (response.ok && /\\/auth\\/logout(-all)?$/.test(path)) window.ui.authActions.logoutWithPersistOption(['bearerAuth'])
    } catch (err) {
      console.warn('Não foi possível aplicar o token automaticamente', err)
    }
    return response
  },
})
`

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, char => HTML_ENTITIES[char])
}
