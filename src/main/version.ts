import { readFileSync } from 'node:fs'

type PackageJson = { version: string }

/** Versão do package.json (vai para a documentação OpenAPI). O Dockerfile copia o package.json para a imagem. */
const packageJson = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
export const APP_VERSION = (JSON.parse(packageJson) as PackageJson).version
