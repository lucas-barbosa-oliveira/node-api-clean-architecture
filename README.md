# API Node.js — Express 5 + Clean Architecture

API de exemplo com Express 5, TypeScript rodando nativamente no Node (sem build), Clean Architecture, jobs assíncronos (202 + consulta por polling), camada de background (tasks na inicialização ou agendadas), MongoDB e Redis (BullMQ) opcionais.

## Stack

- Node.js ≥ 22.18 (TypeScript nativo via *type stripping*: `node arquivo.ts`)
- Express 5, zod 4, Mongoose 9, BullMQ, croner
- Testes: `node:test` + supertest

## Pré-requisitos

| Item | Necessário para | Versão |
|---|---|---|
| Node.js + npm | tudo | ≥ 22.18 (recomendado a LTS atual) |
| Docker + Docker Compose | só o modo completo (Mongo + Redis) | Compose v2 (`docker compose`) |

Verifique: `node -v` e `docker compose version`.

## Passo a passo — modo rápido (sem Docker)

Usa repositórios em memória e fila em processo. Os dados somem ao reiniciar.

```bash
unzip node-api-clean-architecture.zip
cd node-api-clean-architecture
npm install
npm run dev
```

A API sobe em `http://localhost:3000`. Em outro terminal:

```bash
# saúde
curl http://localhost:3000/health

# criar usuário
curl -X POST http://localhost:3000/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ana Souza","email":"ana@exemplo.com"}'

# buscar usuário (use o id retornado)
curl http://localhost:3000/users/<id>

# disparar um relatório: responde 202 na hora, com o cabeçalho Location: /jobs/<id>
curl -i -X POST http://localhost:3000/reports \
  -H 'Content-Type: application/json' \
  -d '{"month":"2026-10"}'

# consultar o job (pending -> running -> succeeded); o relatório demora ~3s
curl http://localhost:3000/jobs/<id>
```

O arquivo `requests.http` tem as mesmas chamadas para VS Code (REST Client) ou JetBrains.

Rodar os testes: `npm test`.

## Passo a passo — modo completo (MongoDB + Redis via Docker)

Persistência em Mongo, fila BullMQ no Redis; permite várias instâncias da API em paralelo.

```bash
npm run docker:up        # sobe mongo e redis e espera ficarem saudáveis
npm run dev:docker       # API com .env.docker (mongo + redis)
```

Testes com as dependências reais (inclui integração BullMQ):

```bash
npm run test:docker
```

Inspecionar:

```bash
docker compose exec mongo mongosh app      # db.users.find(), db.jobs.find()
docker compose exec redis redis-cli        # KEYS bull:*
```

Parar:

```bash
npm run docker:down                 # mantém os dados (volumes)
docker compose down -v              # apaga também os dados
```

Para testar duas instâncias: suba uma com `PORT=3000` e outra com `PORT=3001` (ambas com `--env-file=.env.docker`); as tasks agendadas executam em apenas uma delas e os jobs são consumidos por qualquer uma.

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

`.env.docker` está versionado de propósito: contém apenas valores locais, sem segredos.

## Scripts npm

| Script | O que faz |
|---|---|
| `npm run dev` | API com `--watch` (lê `.env` se existir) |
| `npm start` | API sem watch |
| `npm run dev:docker` / `start:docker` | Igual, usando `.env.docker` |
| `npm test` | Testes (o que depende de Redis é ignorado sem `REDIS_URL`) |
| `npm run test:docker` | Testes contra Mongo/Redis do compose |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run docker:up` / `docker:down` | Sobe / derruba Mongo e Redis |

## Estrutura

```
src/
  domain/          regras de negócio puras
    error/ model/ validator/ utils/
  application/     casos de uso e portas
    service/ port/
  infrastructure/  detalhes técnicos
    database/schema/   schemas Mongoose
    mapper/            modelo <-> JSON do Mongo (transform)
    repository/        base/ (BaseMongoRepository), mongo/, in-memory/
    queue/ redis/
  background/      tasks (startup/agendadas), schedulers, handlers de jobs
  presentation/http/ controllers, rotas, error handler
  di/              composition root (escolhe drivers via ENV)
  main/            app.ts e server.ts
test/              unit, http (supertest) e integration
```

Regra de dependência: `domain` ← `application` ← (`presentation` | `background` | `infrastructure`). Somente `di/` conhece todas as camadas.

## Como estender

- **Novo modelo:** classe em `domain/model` herdando `Entity` → schema em `infrastructure/database/schema` → mapper em `infrastructure/mapper` → repositório Mongo herdando `BaseMongoRepository` e versão em memória → registrar em `di/repositories.ts`.
- **Novo tipo de job assíncrono:** schema de payload em `domain/validator/job.validator.ts` + handler em `background/jobs/handlers.ts`.
- **Nova task de background:** arquivo em `background/tasks/` com `{ name, runOnStartup?, schedule?, run(signal) }` e adicionar em `tasks/index.ts`.

## Problemas comuns

- **`.env not found. Continuing without it.`:** aviso normal do Node quando não há `.env`; os padrões são usados.
- **`EADDRINUSE`:** porta ocupada; use `PORT=3001 npm run dev`.
- **Erro de sintaxe ao importar `.ts` / `ERR_UNKNOWN_FILE_EXTENSION`:** Node antigo; atualize para ≥ 22.18.
- **`ECONNREFUSED` em 27017/6379:** rode `npm run docker:up` antes e confirme com `docker compose ps`.
- **`QUEUE_DRIVER=redis requires REPOSITORY_DRIVER=mongo`:** combinação inválida de propósito; jobs em memória não seriam visíveis entre instâncias.
- **Docker: porta já em uso:** você tem outro Mongo/Redis local; pare-o ou altere a porta em `docker-compose.yml`.

## Notas para produção

- Handlers de job devem ser idempotentes (BullMQ pode reexecutar após falha; há 3 tentativas com backoff).
- Redis com `maxmemory-policy noeviction` e persistência (já no compose).
- `recoverStale` (jobs `running` órfãos após queda) só se aplica ao modo em processo e instância única.
- Em produção, gerencie índices do Mongo por migração em vez de depender de `autoIndex`; adicione autenticação ao Mongo/Redis (o compose local não tem).
