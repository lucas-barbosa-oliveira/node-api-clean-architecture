# API Node.js — Express 5 + Clean Architecture

API de exemplo com Express 5, TypeScript rodando nativamente no Node (sem build), Clean Architecture, jobs assíncronos (202 + consulta por polling), camada de background (tasks na inicialização ou agendadas), autenticação JWT com escopos atrás do Kong Gateway, MongoDB e Redis (BullMQ) opcionais.

## Stack

- Node.js ≥ 22.18 (TypeScript nativo via *type stripping*: `node arquivo.ts`)
- Express 5, zod 4, Mongoose 9, BullMQ, croner
- Autenticação: JWT RS256 com `jose`, senhas com `scrypt` (nativo do Node), Kong Gateway 3.9 (DB-less)
- Testes: `node:test` + supertest

## Pré-requisitos

| Item | Necessário para | Versão |
|---|---|---|
| Node.js + npm | tudo | ≥ 22.18 (recomendado a LTS atual) |
| Docker + Docker Compose | só o modo completo (Mongo + Redis + Kong) | Compose v2 (`docker compose`) |

Verifique: `node -v` e `docker compose version`.

## Passo a passo — modo rápido (sem Docker)

Usa repositórios em memória e fila em processo. Os dados somem ao reiniciar.

```bash
unzip node-api-clean-architecture.zip
cd node-api-clean-architecture
npm install
npm run dev
```

A API sobe em `http://localhost:3000`, e o administrador inicial é criado a partir de `ADMIN_EMAIL`/`ADMIN_PASSWORD` (veja `.env.example`). Em outro terminal:

```bash
API=http://localhost:3000
json() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }

# login do administrador
ADMIN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@exemplo.com","password":"admin-local-123"}' | json access_token)

# admin cadastra um gestor e um cliente
curl -s -X POST $API/users -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"Gabi Gestora","email":"gabi@exemplo.com","password":"senha-gestora","role":"manager"}'
CLIENTE_ID=$(curl -s -X POST $API/users -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"Caio Cliente","email":"caio@exemplo.com","password":"senha-cliente","role":"client"}' | json id)

# gestor faz login e cria um relatório para o cliente: 202 na hora, com Location: /jobs/<id>
GESTOR=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"gabi@exemplo.com","password":"senha-gestora"}' | json access_token)
JOB_ID=$(curl -s -X POST $API/reports -H "Authorization: Bearer $GESTOR" -H 'Content-Type: application/json' \
  -d "{\"clientId\":\"$CLIENTE_ID\",\"month\":\"2026-10\"}" | json id)

# cliente faz login e acompanha o job (pending -> running -> succeeded; ~3s)
CLIENTE=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"caio@exemplo.com","password":"senha-cliente"}' | json access_token)
curl -s $API/jobs/$JOB_ID -H "Authorization: Bearer $CLIENTE"
```

O arquivo `requests.http` tem o mesmo fluxo para VS Code (REST Client) ou JetBrains, já encadeando os tokens.

Rodar os testes: `npm test`.

## Passo a passo — modo completo (MongoDB + Redis via Docker)

Persistência em Mongo, fila BullMQ no Redis e o Kong Gateway na frente da API; permite várias instâncias da API em paralelo.

```bash
npm run docker:up        # gera as chaves JWT e kong/kong.yml; sobe mongo, redis e kong
npm run dev:docker       # API com .env.docker (mongo + redis), na porta 3000
```

Os clientes acessam pelo Kong, em `http://localhost:8000` (mesmas rotas). O `requests.http` já aponta para lá.

Testes com as dependências reais (inclui integração BullMQ):

```bash
npm run test:docker
```

Inspecionar:

```bash
docker compose exec mongo mongosh app      # db.users.find(), db.jobs.find()
docker compose exec redis redis-cli        # KEYS bull:*
curl -s localhost:8001/routes | node -pe "JSON.parse(require('fs').readFileSync(0)).data.map(r=>r.name)"  # rotas no Kong
docker compose logs -f kong                # logs de acesso do gateway
```

Parar:

```bash
npm run docker:down                 # mantém os dados (volumes)
docker compose down -v              # apaga também os dados
```

Para testar duas instâncias: suba uma com `PORT=3000` e outra com `PORT=3001` (ambas com `--env-file=.env.docker`); as tasks agendadas executam em apenas uma delas e os jobs são consumidos por qualquer uma.

## Autenticação e autorização

O controle de acesso é dividido em três níveis:

| Nível | Pergunta | Onde |
|---|---|---|
| Autenticação | O token é válido (assinatura RS256, emissor, expiração)? | Kong (plugin `jwt`) **e** API (`auth.middleware.ts`) |
| Escopo | Este token pode usar esta rota? | API, middleware `guard(...)` em cada rota |
| Dono do recurso | Este usuário pode ver *este* registro? | API, nos services (`JobService`, `UserService`) |

A API valida o token mesmo atrás do Kong (*zero trust*): quem chegar direto na porta 3000 sem token recebe 401.

**Papéis e escopos** (definidos em `src/domain/auth/scopes.ts` e gravados no token no login):

| Papel | Pode | Escopos |
|---|---|---|
| `admin` | cadastrar gestores e clientes; ver qualquer usuário e qualquer job | `users:create` `users:read` `users:read:any` `clients:read` `jobs:read` `jobs:read:any` |
| `manager` | listar clientes; criar jobs associados a um cliente; ver os jobs que criou | `users:read` `clients:read` `jobs:create` `jobs:read` |
| `client` | ver os jobs associados a ele | `users:read` `jobs:read` |

**Rotas:**

| Rota | Acesso |
|---|---|
| `GET /health`, `GET /.well-known/jwks.json` | pública |
| `POST /auth/login` | pública (`{ email, password }` → `{ access_token, token_type, expires_in }`) |
| `POST /users` | `users:create` (admin). Corpo: `{ name, email, password, role: "manager" \| "client" }` |
| `GET /users/me` | autenticado |
| `GET /users/:id` | o próprio id; qualquer id com `users:read:any` |
| `GET /clients` | `clients:read` (admin, gestor) |
| `POST /reports` | `jobs:create` (gestor). Corpo: `{ clientId, month }`; o gestor vem do token |
| `GET /jobs`, `GET /jobs/:id` | gestor vê os que criou, cliente os associados a ele, `jobs:read:any` vê todos |

Recurso de outra pessoa responde **404** (e não 403), para não revelar quais ids existem. Sem escopo para a rota, a resposta é **403**; sem token ou com token inválido, **401**.

**Kong** (`kong/kong.template.yml`, modo DB-less):

- `jwt` nas rotas protegidas: valida assinatura RS256 e `exp`, recusa validade acima de 24h e só aceita o token no header `Authorization`.
- `rate-limiting`: 10 logins/min por IP (freia tentativa de adivinhar senha) e 300 req/min por IP nas rotas protegidas.
- `request-size-limiting` (128 KB) e `correlation-id` (`X-Request-ID` em todas as respostas).

Quem emite os tokens é a própria API, assinando com a chave privada. O Kong só tem a chave pública, cadastrada em um consumer cuja `key` é o `iss` do token (`JWT_ISSUER`). `npm run kong:setup` gera o par de chaves em `keys/` (ignorado pelo git) e monta `kong/kong.yml` a partir do template.

## Variáveis de ambiente

Sem `.env` valem os padrões abaixo. Copie `.env.example` para `.env` para customizar.

| Variável | Padrão | Descrição |
|---|---|---|
| `REPOSITORY_DRIVER` | `memory` | `memory` ou `mongo` |
| `QUEUE_DRIVER` | `in-process` | `in-process` ou `redis` (exige `REPOSITORY_DRIVER=mongo`) |
| `PORT` | `3000` | Porta HTTP |
| `REPORT_DURATION_MS` | `3000` | Duração simulada do relatório |
| `MONGO_URI` / `MONGO_DB` | — | Obrigatórias com `mongo` |
| `REDIS_URL` | — | Obrigatória com `redis` |
| `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` | — | Par de chaves RSA (PEM). Sem elas, a API gera chaves temporárias: os tokens morrem ao reiniciar e o Kong não os aceita |
| `JWT_ISSUER` | `api-clean-architecture` | Claim `iss`; precisa bater com o consumer do Kong |
| `JWT_AUDIENCE` | `api-clean-architecture` | Claim `aud` |
| `JWT_EXPIRES_IN_SECONDS` | `3600` | Validade do token (60 a 86400) |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Administrador criado na inicialização, se ainda não existir |
| `KONG_UPSTREAM_URL` | `http://host.docker.internal:3000` | Só para `npm run kong:setup`: onde o Kong encontra a API |

`.env.docker` está versionado de propósito: contém apenas valores locais (inclusive a senha do admin de desenvolvimento). As chaves ficam em `keys/`, fora do git.

## Scripts npm

| Script | O que faz |
|---|---|
| `npm run dev` | API com `--watch` (lê `.env` se existir) |
| `npm start` | API sem watch |
| `npm run dev:docker` / `start:docker` | Igual, usando `.env.docker` |
| `npm test` | Testes (o que depende de Redis é ignorado sem `REDIS_URL`) |
| `npm run test:docker` | Testes contra Mongo/Redis do compose |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7) |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run kong:setup` | Gera as chaves JWT (se faltarem) e `kong/kong.yml` |
| `npm run docker:up` / `docker:down` | Sobe (rodando `kong:setup` antes) / derruba Mongo, Redis e Kong |

## Estrutura

```
src/
  domain/          regras de negócio puras
    auth/ error/ model/ validator/ utils/
  application/     casos de uso e portas
    service/ port/
  infrastructure/  detalhes técnicos
    database/schema/   schemas Mongoose
    mapper/            modelo <-> JSON do Mongo (transform)
    repository/        base/ (BaseMongoRepository), mongo/, in-memory/
    queue/ redis/
    security/          hash de senha (scrypt) e JWT (jose)
  background/      tasks (startup/agendadas), schedulers, handlers de jobs
  presentation/http/ controllers, rotas, error handler
  di/              composition root (escolhe drivers via ENV)
  main/            app.ts e server.ts
test/              unit, http (supertest) e integration
kong/              kong.template.yml (versionado) -> kong.yml (gerado)
scripts/           setup.kong.ts
keys/              par de chaves dos JWTs (gerado, fora do git)
```

Regra de dependência: `domain` ← `application` ← (`presentation` | `background` | `infrastructure`). Somente `di/` conhece todas as camadas.

## Como estender

- **Novo modelo:** classe em `domain/model` herdando `Entity` → schema em `infrastructure/database/schema` → mapper em `infrastructure/mapper` → repositório Mongo herdando `BaseMongoRepository` e versão em memória → registrar em `di/repositories.ts`.
- **Novo tipo de job assíncrono:** schema de payload em `domain/validator/job.validator.ts` + handler em `background/jobs/handlers.ts`.
- **Nova rota protegida:** crie o escopo em `domain/auth/scopes.ts`, conceda-o aos papéis em `ROLE_SCOPES` e use `guard(SCOPES.x)` na rota. Regras de dono do recurso vão no service. Se o prefixo da rota for novo, inclua-o em `paths` da rota `protected` em `kong/kong.template.yml` e rode `npm run kong:setup && docker compose restart kong`.
- **Nova task de background:** arquivo em `background/tasks/` com `{ name, runOnStartup?, schedule?, run(signal) }` e adicionar em `tasks/index.ts`.

## Problemas comuns

- **`.env not found. Continuing without it.`:** aviso normal do Node quando não há `.env`; os padrões são usados.
- **`EADDRINUSE`:** porta ocupada; use `PORT=3001 npm run dev`.
- **Erro de sintaxe ao importar `.ts` / `ERR_UNKNOWN_FILE_EXTENSION`:** Node antigo; atualize para ≥ 22.18.
- **`ECONNREFUSED` em 27017/6379:** rode `npm run docker:up` antes e confirme com `docker compose ps`.
- **`QUEUE_DRIVER=redis requires REPOSITORY_DRIVER=mongo`:** combinação inválida de propósito; jobs em memória não seriam visíveis entre instâncias.
- **Kong responde 401 `Unauthorized` para um token emitido pela API:** a API está com chaves temporárias ou diferentes das do Kong. Confira `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEY_PATH` no `.env` usado e rode `npm run kong:setup && docker compose restart kong`.
- **Kong responde 502 / `An invalid response was received from the upstream server`:** a API não está rodando na porta 3000 do host, ou um firewall (ex.: `ufw`) bloqueia o acesso vindo da rede do Docker.
- **Kong não sobe e `kong/kong.yml` virou uma pasta:** o compose foi iniciado sem rodar `npm run kong:setup` antes. Apague a pasta e use `npm run docker:up`.
- **`429 API rate limit exceeded` no login:** limite de 10 tentativas por minuto do Kong; aguarde um minuto.
- **Docker: porta já em uso:** você tem outro Mongo/Redis local; pare-o ou altere a porta em `docker-compose.yml`.

## Notas para produção

- Handlers de job devem ser idempotentes (BullMQ pode reexecutar após falha; há 3 tentativas com backoff).
- Redis com `maxmemory-policy noeviction` e persistência (já no compose).
- `recoverStale` (jobs `running` órfãos após queda) só se aplica ao modo em processo e instância única.
- Chaves e senha do admin: em produção, use um gerenciador de segredos em vez de arquivos e `.env`; troque as chaves periodicamente (o `kid` do token muda junto) e atualize o Kong.
- Para vários microserviços, eles validam os tokens com a chave pública (`/.well-known/jwks.json`); só o emissor tem a chave privada.
- Ainda não há refresh token nem revogação: o token vale até expirar (`JWT_EXPIRES_IN_SECONDS`).
- Com várias instâncias do Kong, troque o `policy: local` do `rate-limiting` por `redis` para o limite ser compartilhado.
- Em produção, gerencie índices do Mongo por migração em vez de depender de `autoIndex`; adicione autenticação ao Mongo/Redis (o compose local não tem).
