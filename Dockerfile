# syntax=docker/dockerfile:1

# Imagem da API. O Node >= 22.18 executa TypeScript nativamente (type stripping): não há etapa de build,
# a imagem roda os .ts de src/ diretamente, como em desenvolvimento.
#
# Build:  docker build -t api-clean-architecture .
# Uso normal: docker compose up (serviço "api"), que injeta as variáveis e monta as chaves JWT.

ARG NODE_VERSION=24

# ---- dependências de produção (sem eslint, typescript, supertest...) ----
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---- imagem final ----
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# código e dependências pertencem ao root e ficam somente leitura para o usuário que executa a API
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# usuário sem privilégios (uid 1000, já existe na imagem oficial)
USER node
EXPOSE 3000 9464

# GET /health em HTTP ou HTTPS (SERVER_TLS), apresentando certificado de cliente quando o servidor exige (mTLS)
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD ["node", "src/main/healthcheck.ts"]

# sem npm na frente: o SIGTERM do "docker stop" chega direto ao Node, que encerra de forma graciosa (src/main/server.ts)
CMD ["node", "--import", "./src/main/telemetry.ts", "src/main/server.ts"]
