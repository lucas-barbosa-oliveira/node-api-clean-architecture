# API Node.js — Express 5 + Clean Architecture

[![CI](https://github.com/lucas-barbosa-oliveira/node-api-clean-architecture/actions/workflows/ci.yml/badge.svg)](https://github.com/lucas-barbosa-oliveira/node-api-clean-architecture/actions/workflows/ci.yml)

API em TypeScript executado nativamente pelo Node (sem etapa de build), organizada em Clean Architecture, atrás do Kong Gateway. Ela cobre:

- **Usuários com papéis** (administrador, gestor e cliente), com login por JWT, refresh token com rotação, revogação imediata de sessões e escopos por rota.
- **Jobs assíncronos**: a requisição responde `202` na hora e o resultado é consultado por polling. A fila roda em processo ou no BullMQ (Redis).
- **Dispositivos ESP32** pareados por código, enviando eventos de passagem que são gravados em série temporal (InfluxDB 2).
- **Integração com outros microsserviços** pelo RabbitMQ, com publish/subscribe e RPC, outbox transacional e auditoria de cada requisição.
- **Operação**: liveness/readiness, `503` quando uma dependência cai, OpenTelemetry (traces, métricas e logs no Grafana LGTM), OpenAPI com Swagger UI e CI no GitHub Actions.

Todas as dependências externas são opcionais. Sem Docker, a API roda inteira em memória.

## Sumário

1. [Stack](#stack)
2. [Visão geral](#visão-geral)
3. [Arquitetura](#arquitetura)
4. [Estrutura de pastas](#estrutura-de-pastas)
5. [Formas de inicialização](#formas-de-inicialização)
6. [Autenticação, autorização e o gateway](#autenticação-autorização-e-o-gateway)
7. [TLS: conexões cifradas e mTLS](#tls-conexões-cifradas-e-mtls)
8. [Segredos e certificados com Vault (OpenTofu)](#segredos-e-certificados-com-vault-opentofu)
9. [Implantação no Kubernetes (Helm)](#implantação-no-kubernetes-helm)
10. [Rotas](#rotas)
11. [Listagens: query string](#listagens-query-string)
12. [Jobs assíncronos e tarefas de background](#jobs-assíncronos-e-tarefas-de-background)
13. [Dispositivos (ESP32) e passagens](#dispositivos-esp32-e-passagens)
14. [Barramento de eventos (RabbitMQ)](#barramento-de-eventos-rabbitmq)
15. [Saúde e indisponibilidade](#saúde-e-indisponibilidade)
16. [Logs](#logs)
17. [Observabilidade (OpenTelemetry + Grafana LGTM)](#observabilidade-opentelemetry--grafana-lgtm)
18. [Documentação da API (OpenAPI)](#documentação-da-api-openapi)
19. [Testes](#testes)
20. [Integração contínua](#integração-contínua)
21. [Variáveis de ambiente](#variáveis-de-ambiente)
22. [Scripts npm](#scripts-npm)
23. [Pontos de atenção](#pontos-de-atenção)
24. [Guia para novas implementações](#guia-para-novas-implementações)
25. [Problemas comuns](#problemas-comuns)

---

## Stack

| Área | Tecnologia |
|---|---|
| Runtime | Node.js ≥ 22.18, com TypeScript nativo por *type stripping* (`node arquivo.ts`); a imagem usa Node 24 |
| HTTP | Express 5 |
| Validação | zod 4, que também gera os schemas do OpenAPI |
| Persistência | MongoDB 7 (replica set) com Mongoose 9, ou memória |
| Fila e agendamento | BullMQ (Redis 7), ou fila e agendador em processo (croner) |
| Séries temporais | InfluxDB 2.7.12 (versão fixada; consultas em Flux) com `@influxdata/influxdb-client`, ou memória |
| Barramento | RabbitMQ 4.1 com `amqplib`, compatível com os serviços que usam a `amqp-client-node`; ou memória |
| Autenticação | JWT RS256 (`jose`), refresh token opaco com rotação, senhas com `scrypt` (nativo do Node) |
| Gateway | Kong 3.9: DB-less no ambiente local; Kong Ingress Controller ≥ 3.4 no Kubernetes |
| Segredos e PKI | HashiCorp Vault 1.20 (ou OpenBao): KV, PKI, credenciais dinâmicas do MongoDB e do RabbitMQ, Transit; entregues pelo Vault Agent |
| Infraestrutura como código | OpenTofu ≥ 1.8: módulos do Vault em `platform-infra` (cópia local em `dev/vault`) |
| Implantação | Kubernetes ≥ 1.27, chart base da plataforma (`deploy/values.yaml` é o contrato), Argo CD e GitOps (`matrixgrid-gitops`) |
| Query string | `query-strings-parser` |
| Observabilidade | OpenTelemetry SDK; Grafana LGTM (Tempo, Prometheus, Loki e Grafana) |
| Documentação | OpenAPI 3.1 gerado do código, Swagger UI (`swagger-ui-dist`) em `/reference` |
| Testes | `node:test` + supertest |
| Qualidade | ESLint, TypeScript 7 (`tsc --noEmit`), GitHub Actions, Dependabot, CodeQL (SAST), Trivy (dependências, imagem, IaC) e kubeconform |

---

## Visão geral

```
                         ┌──────────────────────────── rede do Docker ────────────────────────────┐
 navegador / app         │                                                                          │
 ESP32           ──────► │  Kong :8000 ──► API :3000 ──► MongoDB (dados + outbox)                   │
                         │   (JWT, rate      │  │  │ ──► Redis (BullMQ: jobs e tasks agendadas)   │
                         │    limit, X-       │  │  └──► InfluxDB (passagens dos sensores)          │
                         │    Request-ID)     │  └─────► RabbitMQ ◄──► outros microsserviços        │
                         │                    │            (eventos, auditoria, RPC)                │
                         │                    └─ OTLP ─► Grafana LGTM :3001 (traces, métricas, logs)│
                         └──────────────────────────────────────────────────────────────────────────┘
```

**Atores:**

| Papel | O que faz |
|---|---|
| Administrador (`admin`) | Criado na inicialização a partir do `.env`. Cadastra gestores e clientes, vê tudo e derruba sessões |
| Gestor (`manager`) | Solicita relatórios (jobs) para clientes e acompanha os que criou |
| Cliente (`client`) | Acompanha os relatórios associados a ele, pareia os próprios dispositivos e vê as passagens deles |
| Dispositivo (`device`) | ESP32 pareada a um cliente; só envia eventos de passagem |

---

## Arquitetura

### Regra de dependência

```
            ┌──────────────────────────────────────────────┐
            │ main/  (server.ts, app.ts, telemetry.ts)     │  inicia o processo
            └──────────────────────┬───────────────────────┘
            ┌──────────────────────▼───────────────────────┐
            │ di/    composition root                      │  único lugar que conhece todas as camadas
            └───┬──────────────┬──────────────┬────────────┘
  ┌─────────────▼───┐ ┌────────▼────────┐ ┌───▼──────────────┐
  │ presentation/   │ │ background/     │ │ infrastructure/  │  adaptadores (entrada e saída)
  │ HTTP, eventbus  │ │ jobs, tasks     │ │ Mongo, Redis...  │
  └─────────┬───────┘ └────────┬────────┘ └───┬──────────────┘
            └──────────────────▼──────────────┘
                     ┌─────────────────┐
                     │ application/    │  casos de uso + portas (interfaces)
                     └────────┬────────┘
                     ┌────────▼────────┐
                     │ domain/         │  regras de negócio puras
                     └─────────────────┘
```

As setas apontam para dentro. Uma camada só importa as camadas abaixo dela.

- `domain` não importa nada do projeto e nenhuma biblioteca de infraestrutura (só `zod`, para validação).
- `application` importa `domain` e declara **portas** (interfaces), como `IUserRepository`, `IOutbox`, `IEventBus` e `ILogger`. Ela nunca conhece Mongoose, BullMQ, amqplib, Express ou InfluxDB.
- `infrastructure` implementa essas portas (**adaptadores de saída**).
- `presentation` e `background` são **adaptadores de entrada**: transformam HTTP, mensagens do barramento, jobs e cron em chamadas aos services.
- `di` escolhe as implementações conforme as variáveis de ambiente e liga tudo.
- `main` inicia o processo.

Na prática, isso garante três coisas:

- Trocar Mongo por memória, ou RabbitMQ por um barramento em processo, muda só o `di/`.
- Os services são testados sem banco, com os adaptadores em memória.
- A camada HTTP não sabe que existe MongoDB. Por exemplo, ela recebe uma função `isDependencyUnavailable` pronta para decidir o `503`.

### As camadas

#### `domain/`: regras de negócio puras

| Contém | Exemplos |
|---|---|
| **Models** (entidades): estado e comportamento | `User`, `Job` (`start`, `succeed`, `fail`, `involves`), `Session` (`isActive`, `revoke`), `Device`, `PairingCode`, `Passage`. Todos herdam `Entity`: `id` (UUID), `createdAt`, `updatedAt`; toda mutação chama `touch()` |
| **Validadores**: formato da entrada | `user.validator.ts`, `job.validator.ts` (um schema zod por tipo de job), `device.validator.ts` |
| **Erros de negócio**, sem nenhum status HTTP | `ValidationError`, `NotFoundError`, `ConflictError`, `UnauthorizedError`, `ForbiddenError` (cada um com um `code`) |
| **Autorização** | `scopes.ts` (escopos e escopos por papel), `actor.ts` (quem executa a operação) |

**Não pode:** acessar banco, rede, relógio externo, variáveis de ambiente, Express ou logger. A serialização pública é responsabilidade do model: `toJSON()` define o que sai, e por exemplo `User` omite `passwordHash`.

#### `application/`: casos de uso e portas

| Pasta | Contém |
|---|---|
| `service/` | Um service por área: `AuthService`, `UserService`, `JobService`, `DeviceService`, `PassageService`, `ReportService`, `HealthService`. Orquestram o caso de uso: validam a entrada, aplicam as regras de acesso ao recurso (dono, `:any`), chamam repositórios e gravam eventos no outbox dentro da transação |
| `port/` | As interfaces que a aplicação precisa do mundo externo: repositórios, `IJobQueue`, `IPassageStore`, `IEventBus`, `IOutbox`, `IUnitOfWork`, `ITokenService`, `IPasswordHasher`, `ILogger`, `HealthCheck` |
| `query/` | Modelo de listagem (`ListQuery`, `Page`, `Filter`) e o `QuerySchema` de cada recurso, a whitelist do que pode ser filtrado, ordenado e selecionado |
| `event/` | Eventos de integração que este serviço publica (`IntegrationEvents.userCreated`, ...) |
| `audit/` | Montagem do `RequestAuditEvent` e remoção de segredos (`redact`) |

**Não pode:** importar nada de `infrastructure`, `presentation`, `background` ou `di`, nem bibliotecas de I/O.

#### `infrastructure/`: adaptadores de saída

Implementa as portas com tecnologias concretas: Mongoose (schemas, mappers, repositórios, unidade de trabalho), BullMQ, ioredis, InfluxDB, amqplib, `jose`, `scrypt`, o logger e as métricas. Também é aqui que se conhecem os erros dos drivers (`resilience/unavailable.ts`) e que se faz a reconexão com cada dependência. **Não contém regra de negócio.**

#### `presentation/`: adaptadores de entrada

| Pasta | Contém |
|---|---|
| `http/` | Rotas (método + caminho + `guard(escopos)`), controllers finos (leem `req`, chamam o service, escrevem `res`), middlewares (request id, log de acesso, auditoria, autenticação), error handler (código de erro → status HTTP) e o documento OpenAPI |
| `eventbus/` | As "rotas" do barramento: subscribers (eventos que este serviço consome) e recursos RPC que ele oferece |

**Não contém regra de negócio:** um controller nunca decide quem pode ver o quê; isso fica no service.

#### `background/`: adaptadores de entrada sem requisição

| Pasta | Contém |
|---|---|
| `jobs/handlers.ts` | Liga cada tipo de job (`report.generate`) ao service que executa o trabalho |
| `tasks/` | Rotinas de manutenção, executadas na inicialização e/ou por cron (`purge-old-jobs`, `purge-ended-sessions`) |
| `scheduler/` | Dois agendadores: em processo (croner) e BullMQ, este com coordenação entre instâncias |

#### `di/`: composition root

Lê e valida o ambiente (`env.ts`, com zod) e escolhe os drivers, cada um no seu arquivo: `repositories.ts`, `background.ts`, `event.bus.ts` e `timeseries.ts`. Em seguida, `container.ts` instancia os services, o relay do outbox, o health service e a auditoria, e define a ordem de encerramento. **É o único lugar que conhece todas as camadas.**

#### `main/`: processo

| Arquivo | Papel |
|---|---|
| `telemetry.ts` | Carregado com `--import` antes de tudo: inicia o OpenTelemetry (só quando configurado) |
| `server.ts` | Ciclo de vida: sinais, construção do container, recuperação, admin inicial, barramento, HTTP, agendador, relay e encerramento gracioso |
| `app.ts` | Monta o Express: middlewares, rotas e error handler. Não abre porta (os testes usam `createApp` com supertest) |
| `version.ts` | Versão do `package.json`, usada no OpenAPI |

### Fluxo de uma requisição (exemplo: `POST /users`)

```
Kong ── valida JWT (assinatura, exp ≤ 24h), rate limit, 128 KB, X-Request-ID, span "kong"
 │
 ▼  app.ts
requestId ─► accessLog ─► audit (registra ao terminar) ─► express.json (100 KB)
 │
 ▼  user.routes.ts: guard(SCOPES.usersCreate)
authenticate ─► AuthService.authenticate(token)   (assinatura + sessão ativa; 401 se não)
requireScopes ─► 403 se faltar users:create
 │
 ▼  user.controller.ts: create
UserService.create(req.body)
  ├─ validateCreateUser (domain)                           → 400 ValidationError
  ├─ repo.findByEmail                                      → 409 ConflictError
  ├─ User.create(...) + hasher.hash(senha)
  └─ unitOfWork.run { repo.save(user); outbox.add(UserCreatedEvent) }   ← uma transação
 │
 ▼  201 + user.toJSON()  (sem passwordHash)
audit ─► outbox.add(RequestAuditEvent)
OutboxRelay ─► RabbitMQ (users.created, audit.request), no mesmo trace
```

Qualquer erro sobe até o `errorHandler`, que funciona assim:

- `AppError`: o `code` vira status (`VALIDATION`→400, `UNAUTHORIZED`→401, `FORBIDDEN`→403, `NOT_FOUND`→404, `CONFLICT`→409).
- Dependência fora do ar: `503` com `Retry-After`.
- JSON malformado: `400`.
- Qualquer outro: `500`, registrado com o stack.

### Drivers trocáveis

| Variável | Em memória (padrão) | Real | Observação |
|---|---|---|---|
| `REPOSITORY_DRIVER` | `memory` | `mongo` | `mongo` habilita transações (com replica set) e outbox persistente |
| `QUEUE_DRIVER` | `in-process` | `redis` (BullMQ) | `redis` exige `mongo` |
| `TIMESERIES_DRIVER` | `memory` | `influx` | |
| `EVENT_BUS_DRIVER` | `memory` | `rabbitmq` | |

As combinações são livres, exceto `redis` + `memory`, que é recusada na inicialização: o estado dos jobs precisa estar visível para todas as instâncias.

---

## Estrutura de pastas

```
.
├── src/
│   ├── domain/
│   │   ├── auth/
│   │   │   ├── scopes.ts             Escopos (SCOPES), escopos por papel (ROLE_SCOPES) e do dispositivo (DEVICE_SCOPES)
│   │   │   └── actor.ts              Actor (quem executa: id, papel, escopos, sessão, cliente do dispositivo) e hasScope
│   │   ├── error/index.ts            AppError e subclasses (VALIDATION, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT)
│   │   ├── model/
│   │   │   ├── entity.ts             Base: id (UUID), createdAt, updatedAt, touch()
│   │   │   ├── user.ts               Usuário, papéis (USER_ROLES), estado do MFA e toJSON sem hash nem segredos
│   │   │   ├── session.ts            Sessão de login: hash do refresh token, rotação, revogação, expiração absoluta,
│   │   │   │                         métodos do login (amr: pwd, otp, mfa)
│   │   │   ├── mfa.challenge.ts      Segunda etapa do login com MFA (hash do mfa_token, 5 tentativas, uso único)
│   │   │   ├── job.ts                Job assíncrono: pending → running → succeeded | failed
│   │   │   ├── device.ts             Dispositivo pareado (hardwareId, firmware, ativo/revogado)
│   │   │   ├── pairing.code.ts       Código de pareamento (hash, expiração, uso único)
│   │   │   └── passage.ts            Evento de passagem (in/out/unknown) e status do dispositivo
│   │   ├── validator/                Schemas zod da entrada: usuário, payload de cada tipo de job, pareamento e envio
│   │   └── utils/normalize.ts        Normalização (e-mail em minúsculas, etc.)
│   │
│   ├── application/
│   │   ├── service/
│   │   │   ├── auth.service.ts       Login (em duas etapas com MFA), refresh com rotação e detecção de reuso,
│   │   │   │                         autenticação por requisição, sessões
│   │   │   ├── mfa.service.ts        MFA: configurar, ativar, desativar, códigos de recuperação, reset pelo admin
│   │   │   ├── user.service.ts       Cadastro (com UserCreatedEvent na transação), consulta, listagens, admin inicial
│   │   │   ├── job.service.ts        Submissão (202), consulta com regra de dono, listagem, recuperação, limpeza
│   │   │   ├── report.service.ts     Trabalho do job report.generate (simulado por REPORT_DURATION_MS)
│   │   │   ├── device.service.ts     Código de pareamento, troca do código por token, listagem, revogação
│   │   │   ├── passage.service.ts    Recebe lotes de passagens e consulta lista e resumo por janela
│   │   │   └── health.service.ts     Liveness, readiness (timeout de 2 s por verificação) e estado de encerramento
│   │   ├── port/                     Interfaces: *.repository.ts, job.queue, job.handler, passage.store, event.bus,
│   │   │                             outbox, unit.of.work, token.service, refresh.token.codec, password.hasher,
│   │   │                             totp, secret.cipher, recovery.codes, mfa.challenge.repository,
│   │   │                             logger (ILogger, silentLogger), health.check
│   │   ├── query/
│   │   │   ├── list.query.ts         ListQuery, Page, Filter e o helper and() (combina restrição de acesso + filtro)
│   │   │   ├── *.query.schema.ts     O que cada recurso aceita na query string (users, jobs, devices, passages)
│   │   │   └── time.window.ts        Janelas de tempo do resumo de passagens (1m a 31d)
│   │   ├── event/integration.events.ts  Eventos publicados: UserCreated, DevicePaired, DeviceRevoked
│   │   └── audit/
│   │       ├── audit.service.ts      Monta o RequestAuditEvent e grava no outbox
│   │       └── redact.ts             Troca senhas, tokens e códigos por [REDACTED]
│   │
│   ├── infrastructure/
│   │   ├── database/
│   │   │   ├── mongo.database.ts     Conexão própria, models, índices, replica set, ping, reconexão com credenciais
│   │   │   │                         novas e migração de índices (migrateIndexes)
│   │   │   ├── mongo.unit.of.work.ts Transação com AsyncLocalStorage (os repositórios não mudam)
│   │   │   └── schema/               Schemas Mongoose (user, job, session, device, pairing.code, outbox.event,
│   │   │                             mfa.challenge)
│   │   ├── mapper/                   Model ↔ documento do Mongo (BaseMapper.transform é bidirecional)
│   │   ├── repository/
│   │   │   ├── base/base.repository.ts  BaseMongoRepository: CRUD, findPage (filtro/ordem/paginação), erros → domínio
│   │   │   ├── mongo/                Repositórios Mongo (um por agregado)
│   │   │   └── in-memory/            Mesmos contratos em memória (+ in.memory.query.ts, que aplica ListQuery)
│   │   ├── queue/
│   │   │   ├── in.process.job.queue.ts  Fila em processo (concorrência 2)
│   │   │   ├── bullmq.job.queue.ts   Fila BullMQ (3 tentativas com backoff)
│   │   │   ├── run.job.ts            Execução comum: muda status, grava resultado, métricas
│   │   │   └── queue.errors.ts
│   │   ├── redis/redis.connections.ts   Conexões ioredis nomeadas, com logs de queda/retorno e status
│   │   ├── timeseries/               InfluxDB (gravação idempotente, Flux com filtros escapados) e versão em memória
│   │   ├── eventbus/
│   │   │   ├── managed.connection.ts Conexão AMQP com reconexão infinita e log do motivo de cada falha
│   │   │   ├── rabbitmq.event.bus.ts Publish com confirmação, subscribers, servidor e cliente RPC (direct reply-to)
│   │   │   ├── in.memory.event.bus.ts  Mesmo contrato, dentro do processo
│   │   │   └── topic.ts              Casamento de routing key com * e #
│   │   ├── outbox/
│   │   │   ├── mongo.outbox.ts       Outbox persistente (reserva atômica, nova tentativa, estatísticas)
│   │   │   ├── in.memory.outbox.ts
│   │   │   ├── outbox.store.ts       Contrato do armazenamento e captura do contexto do trace
│   │   │   └── outbox.relay.ts       Publica pendentes, com backoff até 5 min e métricas
│   │   ├── security/                 JWT RS256 (jose) e JWKS, chaves, refresh token, scrypt, tls.ts (leitura dos
│   │   │                             certificados e opções de TLS de cliente e de servidor), totp.ts (RFC 6238),
│   │   │                             aes.secret.cipher.ts (AES-256-GCM com rotação), vault.transit.cipher.ts
│   │   │                             (cifra pelo Vault Transit, com rewrap) e recovery.codes.ts
│   │   ├── secrets/secret.file.watcher.ts  Relê arquivos de segredos e certificados e reconfigura as conexões
│   │   ├── vault/vault.client.ts     Cliente HTTP mínimo do Vault (token do arquivo do Agent, TLS, 503 se fora do ar)
│   │   ├── resilience/
│   │   │   ├── retry.ts              Tentativas na inicialização com espera crescente; esconde senha de URIs
│   │   │   └── unavailable.ts        Reconhece "dependência fora do ar" nos erros dos drivers (→ 503)
│   │   ├── logger/console.logger.ts  Logger em texto ou JSON, com trace_id, também enviado por OTLP (Loki)
│   │   └── telemetry/metrics.ts      Métricas de negócio (jobs, passagens)
│   │
│   ├── presentation/
│   │   ├── http/
│   │   │   ├── *.routes.ts           Rotas de cada área com guard(escopos)
│   │   │   ├── *.controller.ts       Controllers: req → service → res
│   │   │   ├── health.routes.ts      /health, /health/live, /health/ready
│   │   │   ├── auth.middleware.ts    authenticate, requireScopes, guard, getActor
│   │   │   ├── request.id.middleware.ts   X-Request-ID (do Kong ou novo)
│   │   │   ├── access.log.middleware.ts   Uma linha por requisição (health só em debug)
│   │   │   ├── audit.middleware.ts   Captura entrada e resposta para a auditoria
│   │   │   ├── error.handler.ts      Código de erro → status; 503 + Retry-After; 500 com stack no log
│   │   │   ├── query/list.query.parser.ts  query-strings-parser + validação contra o QuerySchema; X-Total-Count
│   │   │   └── openapi/              document.ts (rotas), components.ts (respostas), list.parameters.ts,
│   │   │                             json.schema.ts (zod → JSON Schema), docs.routes.ts (Swagger UI)
│   │   └── eventbus/
│   │       ├── subscribers.ts        Eventos consumidos (nenhum ativo hoje; o arquivo tem um exemplo comentado)
│   │       ├── rpc.resources.ts      Recursos RPC: users.find, users.findone, jobs.find
│   │       └── index.ts              Registra subscribers e recursos no barramento
│   │
│   ├── background/
│   │   ├── task.ts                   Contrato BackgroundTask { name, runOnStartup?, schedule?, run(signal) }
│   │   ├── tasks/                    purge-old-jobs (ao iniciar e 03:00) e purge-ended-sessions (03:30); index.ts registra
│   │   ├── jobs/handlers.ts          Tipo de job → service
│   │   └── scheduler/                in.process.scheduler.ts e bullmq.scheduler.ts (fuso America/Recife)
│   │
│   ├── di/
│   │   ├── env.ts                    Schema zod de todas as variáveis, com padrões e combinações válidas (inclusive
│   │   │                             o TLS de cada conexão, resolvido em env.tls)
│   │   ├── container.ts              Composition root, health checks e ordem de encerramento
│   │   ├── repositories.ts           Mongo ou memória (+ outbox, unidade de trabalho, health check)
│   │   ├── background.ts             BullMQ ou em processo (+ health check do Redis)
│   │   ├── event.bus.ts / timeseries.ts / logger.ts
│   │   └── secrets.ts                Valor atual de cada segredo (<VAR>_FILE) e arquivos que cada conexão observa
│   │
│   └── main/
│       ├── server.ts                 Inicialização, sinais (SIGTERM, SIGHUP recarrega o certificado) e encerramento
│       ├── app.ts                    Monta o Express (middlewares e rotas), sem abrir porta
│       ├── http.server.ts            Abre a porta em HTTP ou HTTPS (SERVER_TLS), com mTLS opcional
│       ├── healthcheck.ts            HEALTHCHECK da imagem: GET /health em HTTP ou HTTPS (com certificado no mTLS)
│       ├── migrate.ts                Migração de índices do MongoDB (npm run db:migrate; job do deploy)
│       ├── telemetry.ts              OpenTelemetry (carregado com --import)
│       └── version.ts
│
├── test/
│   ├── unit/                         Services, models, fila, agendador, outbox, health, logger, query string
│   ├── http/                         Rotas com supertest (auth, users, reports, devices, sessions, health, audit,
│   │                                 openapi, este validando cada resposta contra o documento)
│   ├── integration/                  Contra as dependências reais: BullMQ, InfluxDB, RabbitMQ (com DLQ), outbox no
│   │                                 Mongo, reconexão e migração de índices (reload.test.ts)
│   ├── helpers/                      makeApp (app com banco e fila próprios), fixtures, waitForJob, waitUntil,
│   │                                 connections.ts (TLS e credenciais do ambiente para conexões diretas), mfa.ts
│   └── fixtures/helm/                Ambientes de exemplo (dev, sem Vault) para o teste de contrato com o chart base
│
├── kong/
│   ├── kong.template.yml             Configuração do gateway (versionada), com placeholders
│   └── kong.yml                      Gerado por npm run kong:setup (fora do git)
├── infra/local/mongo/healthcheck.js  Modo Vault local: inicia o replica set e cria o administrador usado pelo Vault
├── dev/vault/                        Vault LOCAL (OpenTofu): main.tf com o ambiente "local" e modules/, cópia dos
│                                     módulos de platform-infra (npm run vault:sync-modules)
├── deploy/
│   ├── values.yaml                   Contrato com o chart base da plataforma: env, arquivos e templates do Vault Agent
│   │                                 (fonte única, também usada no ambiente local), migração, rotas do Kong, alertas
│   └── vault-agent/agent.local.hcl   Configuração do Vault Agent local (container vault-agent)
├── observability/
│   ├── grafana/dashboards/api.json   Dashboard da API (SLOs, HTTP, outbox e DLQ, jobs, runtime, logs e traces)
│   ├── grafana/dashboards.yaml       Provisionamento do dashboard
│   ├── grafana/alerting/api.yaml     Alertas de SLO e de operação, provisionados no Grafana
│   └── prometheus.yml                Prometheus avulso (profile "metrics")
├── rabbitmq/                         20-tls.conf (TLS, no docker-compose.tls.yml) e 30-vault.conf (administração
│                                     em HTTP interno, para o Vault criar usuários, no docker-compose.vault.yml)
├── scripts/
│   ├── setup.kong.ts                 Gera as chaves JWT (se faltarem) e kong/kong.yml (com TLS até a API se https)
│   ├── setup.tls.ts                  Gera a CA local e os certificados de cada serviço em certs/
│   ├── tls.certificates.ts           Geração com openssl (usada pelo setup e pelos testes)
│   ├── sync.vault.modules.ts         Copia os módulos do Vault de ../platform-infra para dev/vault/modules
│   └── vault.local.ts                Modo Vault local: recria o Vault, aplica o módulo OpenTofu, gera a configuração
│                                     do Agent, migra os índices e sobe os serviços na ordem
├── keys/                             Par de chaves RSA dos JWTs (gerado, fora do git)
├── certs/                            CA e certificados TLS (gerados por npm run tls:setup ou pelo Vault; fora do git)
├── .vault/                           Modo Vault local: segredos entregues pelo Agent, AppRole, estado (fora do git)
├── .gitlab-ci.yml                    CI no GitLab (destino): componentes de platform/ci-templates e promoção GitOps
├── renovate.json                     Renovate (no GitLab, no lugar do Dependabot), com o preset da plataforma
├── .github/                          workflows/ci.yml, workflows/codeql.yml e dependabot.yml (transição, enquanto no GitHub)
├── .trivyignore                      Achados do Trivy aceitos (com motivo)
├── Dockerfile / .dockerignore        Imagem da API (sem build; Node executa src/ direto)
├── docker-compose.yml                Mongo, Redis, InfluxDB, RabbitMQ, LGTM, Prometheus (opcional), API e Kong
├── docker-compose.tls.yml            Camada que liga TLS (e mTLS) em todos os serviços e na API
├── docker-compose.vault.yml          Camada do Vault (sobre a de TLS): Vault dev, Vault Agent, Mongo e Redis com senha
├── .env.example                      Todas as variáveis, comentadas (copie para .env)
├── .env.docker                       Valores locais para o modo Docker (versionado de propósito)
├── .env.tls                          Camada de TLS sobre o .env.docker, para a API no host (versionado)
├── .env.vault                        Camada do Vault sobre o .env.tls: segredos lidos de .vault/secrets (versionado)
├── requests.http                     Fluxo completo para o REST Client (VS Code) / JetBrains
├── eslint.config.mjs, tsconfig*.json
└── package.json
```

---

## Formas de inicialização

### Pré-requisitos

| Item | Necessário para | Versão |
|---|---|---|
| Node.js + npm | tudo | ≥ 22.18 (recomendado a LTS atual) |
| Docker + Docker Compose | modos com dependências reais | Compose v2 (`docker compose`) |
| Espaço em disco | modo completo | ~6 GB para as imagens (o LGTM sozinho tem ~2,7 GB) |
| OpenSSL | modo com TLS (gera os certificados) | qualquer versão atual (`openssl version`) |
| OpenTofu | modo com Vault (aplica `dev/vault`) | ≥ 1.8 (`tofu version`) |
| Helm e `../platform-infra` (opcional) | teste de contrato com o chart base (`helm.test.ts`) | 3.x |

```bash
git clone https://github.com/lucas-barbosa-oliveira/node-api-clean-architecture.git
cd node-api-clean-architecture
npm install
```

### Resumo

| Modo | Comando | Dependências | Acesso | Quando usar |
|---|---|---|---|---|
| 1. Rápido | `npm run dev` | nenhuma (tudo em memória) | `http://localhost:3000` | Desenvolver regra de negócio, rodar testes, demonstrar |
| 2. Infra em containers + API no host | `npm run docker:infra` e `npm run dev:docker` | Mongo, Redis, InfluxDB, RabbitMQ, LGTM e Kong em containers | `http://localhost:8000` (Kong) ou `:3000` (direto) | Desenvolver com tudo real e `--watch` |
| 3. Tudo em containers | `npm run docker:up` | inclusive a API (build do Dockerfile) | `http://localhost:8000` (Kong) | Validar a imagem, ambiente parecido com produção |
| 4. Sem watch | `npm start` / `npm run start:docker` | igual ao 1 / igual ao 2 | `:3000` | Executar como em produção, no host |
| 5. Misto | `npm run dev` com variáveis no `.env` | só as que você ligar | `:3000` | Ex.: Mongo real e barramento em memória |
| 6. Com TLS | `npm run docker:up:tls`, ou `docker:infra:tls` e `dev:docker:tls` | as mesmas dos modos 2 e 3, com TLS e mTLS | `https://localhost:8443` (Kong) | Validar o ambiente cifrado de ponta a ponta |
| 7. Com Vault | `npm run docker:up:vault`, ou `docker:infra:vault` e `dev:docker:vault` | as do modo 6, mais Vault e Vault Agent | `https://localhost:8443` (Kong); Vault em `http://localhost:8200` | Desenvolver como no Kubernetes: segredos, certificados e credenciais vindos do Vault |

#### 1. Modo rápido (sem Docker)

```bash
npm run dev
```

Usa repositórios, fila, séries temporais e barramento em memória; os dados somem ao reiniciar. O administrador inicial vem de `ADMIN_EMAIL`/`ADMIN_PASSWORD` (veja `.env.example`; sem `.env`, nenhum admin é criado e o log avisa). Sem as chaves em `JWT_*_KEY_PATH`, a API gera chaves temporárias. Fluxo de exemplo em outro terminal:

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

# gestor faz login e pede um relatório para o cliente: 202 na hora, com Location: /jobs/<id>
GESTOR=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"gabi@exemplo.com","password":"senha-gestora"}' | json access_token)
JOB_ID=$(curl -s -X POST $API/reports -H "Authorization: Bearer $GESTOR" -H 'Content-Type: application/json' \
  -d "{\"clientId\":\"$CLIENTE_ID\",\"month\":\"2026-10\"}" | json id)

# cliente faz login e acompanha o job (pending -> running -> succeeded; ~3 s)
CLIENTE=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"caio@exemplo.com","password":"senha-cliente"}' | json access_token)
curl -s $API/jobs/$JOB_ID -H "Authorization: Bearer $CLIENTE"
```

O `requests.http` tem o mesmo fluxo (e o dos dispositivos) já encadeando os tokens. A documentação interativa fica em `http://localhost:3000/reference`.

#### 2. Infra em containers, API no host

```bash
npm run docker:infra   # gera chaves e kong/kong.yml (upstream host.docker.internal:3000); sobe mongo, redis,
                       # influxdb, rabbitmq, lgtm e kong
npm run dev:docker     # API no host com .env.docker e --watch, na porta 3000
```

O Kong, em container, alcança a API do host por `host.docker.internal:3000`. Os clientes usam `http://localhost:8000`. A API também responde direto em `:3000`, o que é útil para depurar, e continua exigindo token.

#### 3. Tudo em containers

```bash
npm run docker:up      # gera chaves e kong/kong.yml (upstream api:3000); build da imagem; sobe tudo e espera ficar saudável
npm run docker:logs    # logs da API
```

A porta da API não é publicada no host, então todo acesso passa pelo Kong (`http://localhost:8000`). Para trocar entre os modos 2 e 3, basta rodar o outro script: o `kong/kong.yml` é regerado e o Kong recriado.

**Escalar:** `docker compose up -d --scale api=3`. O Kong distribui entre as instâncias pelo DNS do Docker; os jobs e as tasks agendadas continuam coordenados pelo Redis, e o outbox impede publicação duplicada.

**Duas instâncias no host (modo 2):** suba a segunda com outra porta e outro `/metrics`, por exemplo `PORT=3002 OTEL_METRICS_PORT=9465 npm run start:docker`. A 3001 é do Grafana. As tasks agendadas executam em apenas uma instância, e os jobs são consumidos por qualquer uma.

#### 4. Sem watch

`npm start` (com `.env`) e `npm run start:docker` (com `.env.docker`) são iguais aos modos 1 e 2, sem reiniciar ao salvar.

#### 5. Configurações mistas

Cada driver é independente. Por exemplo, para Mongo real, fila em processo e barramento em memória:

```bash
docker compose up -d --wait mongo
REPOSITORY_DRIVER=mongo MONGO_URI='mongodb://127.0.0.1:27017/?directConnection=true' npm run dev
```

#### 6. Com TLS em todas as conexões

```bash
npm run docker:up:tls      # certificados (tls:setup), kong.yml com upstream https, tudo em containers com TLS
# ou, com a API no host:
npm run docker:infra:tls   # dependências e Kong com TLS
npm run dev:docker:tls     # API no host com .env.docker + .env.tls (HTTPS na 3000, mTLS)

curl --cacert certs/ca.crt https://localhost:8443/health/ready
```

Os detalhes (o que cifra cada trecho, variáveis, certificados) estão em [TLS: conexões cifradas e mTLS](#tls-conexões-cifradas-e-mtls).

#### 7. Com Vault (como no Kubernetes)

```bash
npm run docker:up:vault      # recria o Vault (dev), aplica dev/vault com OpenTofu, sobe tudo com TLS
# ou, com a API no host:
npm run docker:infra:vault   # dependências, Vault e Vault Agent
npm run dev:docker:vault     # API no host com .env.docker + .env.tls + .env.vault

curl --cacert certs/ca.crt https://localhost:8443/health/ready   # inclui o check "vault"
```

Os certificados dos serviços, as credenciais do Mongo e do RabbitMQ (temporárias), as senhas e as chaves vêm do Vault. Os detalhes estão em [Segredos e certificados com Vault](#segredos-e-certificados-com-vault-opentofu). Para voltar aos outros modos, use `npm run docker:down` (remove também os containers do Vault) e suba o modo desejado. O Mongo do modo Vault usa um volume próprio, com autenticação.

#### Componentes opcionais

| Componente | Como ligar | Endereço |
|---|---|---|
| Observabilidade | `OTEL_EXPORTER_OTLP_ENDPOINT` definido (já no `.env.docker` e no compose) | Grafana em `http://localhost:3001` |
| Prometheus avulso | `docker compose --profile metrics up -d prometheus` | `http://localhost:9090` |
| Documentação | `API_DOCS_ENABLED=true` (padrão) | `/reference` |
| Auditoria | `AUDIT_ENABLED=true` (padrão) | exchange `audit` |

#### Inspecionar e parar

```bash
docker compose exec mongo mongosh app      # db.users.find(), db.jobs.find(), db.outbox_events.find()
docker compose exec redis redis-cli        # KEYS bull:*
curl -s localhost:8001/routes | node -pe "JSON.parse(require('fs').readFileSync(0)).data.map(r=>r.name)"  # rotas no Kong
docker compose logs -f kong                # logs de acesso do gateway
# RabbitMQ: http://localhost:15672 (app / app-rabbit-local)
# InfluxDB: http://localhost:8086 (admin / admin-influx-local), bucket "sensors"
# Grafana:  http://localhost:3001 -> Dashboards > API > API Clean Architecture
# Métricas: http://localhost:9464/metrics

npm run docker:down                 # para os containers e mantém os dados (volumes)
docker compose down -v --remove-orphans   # apaga também os dados (inclusive do modo Vault)
```

### O que acontece na inicialização

1. `telemetry.ts` inicia o OpenTelemetry, se `OTEL_EXPORTER_OTLP_ENDPOINT` estiver definido.
2. As variáveis são validadas (`di/env.ts`).
   - Os segredos com `<VAR>_FILE` são lidos dos arquivos.
   - Derrubam o processo na hora, sem tentativas: um valor inválido (mensagem do zod), uma combinação de TLS incoerente (ex.: `RABBITMQ_TLS=true` com `amqp://`) e um certificado ou arquivo de segredo ausente ou ilegível.
3. Os sinais `SIGINT`/`SIGTERM` passam a ser tratados. Um `docker stop` durante as tentativas de conexão encerra o processo na hora.
4. O container é montado. O MongoDB e o Redis são **aguardados**: a API tenta até conseguir, com espera crescente até 15 s, registrando cada falha. O InfluxDB e o RabbitMQ **não bloqueiam** a inicialização.
5. `recover()` recoloca na fila os jobs órfãos (só no modo em processo) e `ensureAdmin()` cria o admin, se não existir.
6. Os subscribers e os recursos RPC são registrados, e o barramento conecta em segundo plano.
7. O servidor HTTP (ou HTTPS) começa a ouvir, o agendador inicia (tasks `runOnStartup` e cron) e o relay do outbox começa a publicar.
8. A recarga automática de segredos e certificados começa (`SECRETS_RELOAD_INTERVAL_MS`), e, com `HEALTH_PORT`, sobe a porta só de saúde.

**Encerramento gracioso**, ao receber `SIGTERM`:

1. `/health/ready` passa a responder 503, e o balanceador para de mandar tráfego.
2. O servidor HTTP para de aceitar conexões e termina as requisições em andamento.
3. O agendador e a fila terminam o que estão executando.
4. O relay do outbox para.
5. O barramento, o InfluxDB e o MongoDB fecham.
6. Os últimos spans são enviados.

No compose, `stop_grace_period: 30s`.

### Imagem Docker

- **Sem etapa de build:** o Node executa `src/*.ts` direto, como em desenvolvimento.
- **Duas etapas:** a primeira instala só as dependências de produção (`npm ci --omit=dev`); a final, em `node:24-alpine`, copia `node_modules`, `package.json` e `src/`.
- **Fora da imagem:** `.env*`, `keys/`, `certs/`, testes e configurações de lint (veja `.dockerignore`). As variáveis vêm do `.env.docker` via `env_file`, com os hosts trocados pelos nomes dos serviços; as chaves entram por volume somente leitura.
- **Execução:** usuário `node` (sem root), sistema de arquivos somente leitura, `no-new-privileges` e `HEALTHCHECK` em `/health` (`src/main/healthcheck.ts`, que usa HTTPS quando `SERVER_TLS=true` e apresenta o próprio certificado quando o servidor exige mTLS). O `CMD` chama `node` direto, sem `npm` na frente, para o `SIGTERM` chegar ao processo.
- **Portas expostas:** 3000 (HTTP, ou HTTPS com `SERVER_TLS=true`) e 9464 (`/metrics`, sempre HTTP). Com `HEALTH_PORT` (8081 no chart), uma porta só com `/health*` em HTTP, para as probes do Kubernetes.

---

## Autenticação, autorização e o gateway

### Divisão de responsabilidades

| Nível | Pergunta | Quem responde |
|---|---|---|
| Autenticação | O token é válido (assinatura RS256, emissor, expiração)? | **Kong** (plugin `jwt`) **e** API (`auth.middleware.ts`) |
| Segundo fator | O usuário com MFA provou o código do aplicativo? O papel exige MFA? | API (`POST /auth/mfa/verify` e escopos condicionados ao `amr` da sessão) |
| Sessão | A sessão do token ainda está ativa (sem logout ou revogação)? O dispositivo continua ativo? | API, a cada requisição |
| Escopo | Este token pode usar esta rota? | API, `guard(...escopos)` em cada rota |
| Dono do recurso | Este usuário pode ver *este* registro? | API, nos services |
| Abuso | Muitas tentativas? Payload grande? | Kong (`rate-limiting`, `request-size-limiting`) |

A API **valida o token de novo** mesmo atrás do Kong (*zero trust*): quem alcançar a porta 3000 sem passar pelo gateway continua sem acesso. O Kong, por sua vez, recusa tokens inválidos antes de chegarem à API, o que poupa a aplicação de tráfego ilegítimo.

**Quem emite os tokens é a própria API**, assinando com a chave privada (`keys/jwt.private.pem`). O Kong só tem a chave pública, cadastrada em um *consumer* cuja `key` é o `iss` do token (`JWT_ISSUER`): ele consegue validar, mas não emitir. Outros serviços podem validar os tokens com a chave pública publicada em `/.well-known/jwks.json`. O `npm run kong:setup` gera o par de chaves (se faltar) e monta `kong/kong.yml` a partir do template.

```
cliente                   Kong                                API
  │ POST /auth/login       │  rate limit 10/min por IP           │
  │───────────────────────►│────────────────────────────────────►│ confere senha (scrypt), abre sessão
  │◄───────────────────────│◄──── access_token (JWT 15 min) ─────│ assina RS256 (iss, aud, sub, sid, scope)
  │                        │      refresh_token (opaco, 7 dias)   │
  │ GET /jobs              │                                      │
  │ Authorization: Bearer  │  jwt: assinatura, exp, validade≤24h │
  │───────────────────────►│────────────────────────────────────►│ valida de novo + sessão ativa + escopo
  │                        │  (401 aqui se o token for inválido)  │ + regra de dono (no service)
  │◄───────────────────────│◄────────────── 200 / 403 / 404 ─────│
```

### Tokens

| Token | Formato | Validade | Uso | Validado por |
|---|---|---|---|---|
| Access token | JWT RS256: `iss`, `aud`, `sub` (usuário), `sid` (sessão), `scope`, `role`, `amr` (métodos do login) | `JWT_EXPIRES_IN_SECONDS` (15 min) | `Authorization: Bearer` em todas as rotas protegidas | Kong + API (assinatura, sessão ativa) |
| Refresh token | Opaco: `<id da sessão>.<segredo>`; a API guarda só o SHA-256 do segredo | `REFRESH_TOKEN_TTL_SECONDS` (7 dias, absoluta) | Só em `POST /auth/refresh` | API (o Kong não o valida, porque não é JWT) |
| `mfa_token` | Opaco: `<id do desafio>.<segredo>`; a API guarda só o SHA-256 | `MFA_CHALLENGE_TTL_SECONDS` (5 min), 5 tentativas, uso único | Só em `POST /auth/mfa/verify` (segunda etapa do login com MFA) | API |
| Token de dispositivo | JWT RS256 com `scope: telemetry:write`, `sub` = dispositivo, id do cliente | `DEVICE_TOKEN_TTL_SECONDS` (1 ano) | Só em `POST /devices/:id/passages` | Kong (rota própria, aceita até 365 dias) + API (dispositivo ativo) |

### Sessões, refresh e revogação

- **Rotação:** cada refresh token vale uma vez. O refresh devolve um par novo, e o refresh token antigo deixa de valer.
- **Detecção de reuso:** reapresentar um refresh token já usado indica cópia vazada, então a **sessão inteira é revogada**, inclusive o access token dela. Dois refreshes simultâneos com o mesmo token caem nessa regra, por isso o cliente deve serializar a renovação.
- **Revogação imediata:** a cada requisição a API confere se a sessão do token está ativa. Logout, logout-all e a revogação pelo admin valem na hora, mesmo para access tokens ainda dentro do prazo. O Kong não sabe de revogações; quem recusa é a API.
- **Validade absoluta:** renovar não estende os 7 dias. Depois disso, só com novo login.
- **Limpeza:** a task `purge-ended-sessions` (todo dia às 03:30) remove sessões encerradas há mais de 7 dias.

### Autenticação multifator (MFA)

O segundo fator é um **código de 6 dígitos de um aplicativo autenticador** (TOTP, RFC 6238: Google Authenticator, Microsoft Authenticator, 1Password, Authy...), com **10 códigos de recuperação** para quando o celular não estiver à mão. O MFA é opcional por usuário, e pode ser **obrigatório por papel** com `MFA_REQUIRED_ROLES`.

**Ativar** (usuário autenticado):

```
POST /auth/mfa/setup   ──► { secret, otpauth_url, expires_in }    o app lê o otpauth_url como QR code (10 min para confirmar)
POST /auth/mfa/enable  { code: "123456" }
                       ──► { recovery_codes: [10 códigos] }       mostrados só agora; o MFA passa a valer
```

Ao ativar, a sessão atual passa a valer como multifator e **as outras sessões do usuário são encerradas**, porque foram abertas só com senha.

**Login com MFA** (duas etapas):

```
cliente                          API
  │ POST /auth/login {email,senha} │
  │───────────────────────────────►│ senha confere e o usuário tem MFA: não abre sessão ainda
  │◄── { mfa_required: true, ──────│
  │      mfa_token, mfa_methods,   │
  │      expires_in: 300 }         │
  │ POST /auth/mfa/verify          │
  │  { mfa_token, code }           │
  │───────────────────────────────►│ confere o código (TOTP ou de recuperação), abre a sessão com amr
  │◄── access_token + refresh ─────│ ["pwd","otp","mfa"] (ou ["pwd","mfa"] com código de recuperação)
```

Quem não tem MFA continua recebendo os tokens direto do `POST /auth/login`: os clientes atuais não mudam.

**Proteções:**

| Ameaça | Proteção |
|---|---|
| Adivinhar o código (1 em 1.000.000) | 5 tentativas por `mfa_token`, contadas **antes** de conferir (requisições em paralelo não furam o limite); depois, só com novo login (10/min no Kong). A rota `auth-mfa-verify` tem 10/min e 60/h por IP |
| Reaproveitar um código interceptado | Cada código TOTP vale **uma vez**: a API guarda o último passo de 30 s usado e só aceita passos posteriores (atômico no banco) |
| Relógio do celular dessincronizado | Tolerância de ±30 s (um passo para cada lado) |
| Vazamento do banco | O segredo TOTP fica **cifrado** (AES-256-GCM, `MFA_ENCRYPTION_KEY`); os códigos de recuperação e o `mfa_token`, só como SHA-256. Ninguém gera códigos a partir do banco sem a chave |
| Token roubado desligar o MFA | Desativar exige um código (do aplicativo ou de recuperação); gerar novos códigos de recuperação exige o do aplicativo |
| Segredos na auditoria e nos logs | `mfa_token`, `recovery_codes`, `otpauth_url`, `secret` e o campo `code` dos pedidos viram `[REDACTED]`; as respostas com segredo têm `Cache-Control: no-store` |

**MFA obrigatório por papel** (`MFA_REQUIRED_ROLES=admin`, por exemplo):

1. **Login sem MFA ativo:** o usuário desse papel recebe tokens **sem escopos** e com `mfa_enrollment_required: true`. As rotas com escopo respondem 403 com instruções. As rotas que só exigem autenticação continuam valendo: configurar o MFA e gerenciar as sessões.
2. **Depois de ativar:** um `POST /auth/refresh` devolve os escopos do papel, porque a sessão foi elevada na ativação.
3. **Sessões abertas antes de a regra valer:** perdem os escopos no próximo refresh. Para esses papéis, só vale como completa uma sessão com segundo fator.

**Celular perdido:**

- o usuário entra com um código de recuperação e configura de novo (`disable` com um código de recuperação, depois `setup` e `enable`);
- sem os códigos, um administrador chama `DELETE /users/:id/mfa` (escopo `mfa:reset:any`), que desliga o MFA e encerra as sessões do usuário. Ele entra só com a senha e configura de novo.

**Rotação da chave de cifra:**

1. Gere uma chave nova (`openssl rand -base64 32`).
2. Coloque-a em `MFA_ENCRYPTION_KEY` e mova a antiga para `MFA_ENCRYPTION_PREVIOUS_KEYS`.
3. Cada segredo é cifrado de novo com a chave atual no próximo uso.
4. Remova a chave antiga quando nenhum segredo depender dela.

Perder a chave sem rotação torna os segredos ilegíveis: os usuários precisarão de reset pelo admin.

**Com o Vault (`MFA_CIPHER=vault-transit`):** a cifra é feita pelo motor Transit, e a chave nunca sai do Vault.
- **Rotação:** é do próprio Vault (automática a cada 30 dias no módulo); no próximo uso, cada segredo passa para a versão nova por *rewrap*.
- **Migração:** mantenha a `MFA_ENCRYPTION_KEY` antiga durante a troca, e os segredos no formato local passam para o Transit no próximo uso.
- **Vault fora do ar:** o login com MFA e a configuração do MFA respondem 503; o resto da API continua.

### Papéis e escopos

Os escopos ficam no token (claim `scope`), concedidos no login conforme o papel (`ROLE_SCOPES` em `src/domain/auth/scopes.ts`).

**Convenção:** `<recurso>:<ação>` dá acesso aos **próprios** registros, e o sufixo **`:any`** dá acesso aos de **qualquer** usuário. A regra do `:any` é aplicada no service, não na rota. A rota exige o escopo base, e o service decide se mostra só os do usuário ou todos.

| Escopo | Significado | admin | manager | client | device |
|---|---|:-:|:-:|:-:|:-:|
| `users:create` | Cadastrar gestores e clientes | ✅ | | | |
| `users:read` | Ver o próprio cadastro | ✅ | ✅ | ✅ | |
| `users:read:any` | Ver e listar qualquer usuário | ✅ | | | |
| `clients:read` | Listar clientes (para associar a jobs) | ✅ | ✅ | | |
| `jobs:create` | Solicitar relatórios para um cliente | | ✅ | | |
| `jobs:read` | Ver jobs que criou (gestor) ou associados a ele (cliente) | ✅ | ✅ | ✅ | |
| `jobs:read:any` | Ver qualquer job | ✅ | | | |
| `sessions:revoke:any` | Encerrar sessões de qualquer usuário | ✅ | | | |
| `mfa:reset:any` | Redefinir o MFA de qualquer usuário (celular e códigos perdidos) | ✅ | | | |
| `devices:read` | Listar os próprios dispositivos | ✅ | | ✅ | |
| `devices:read:any` | Listar dispositivos de todos | ✅ | | | |
| `devices:manage` | Gerar código de pareamento e revogar os próprios dispositivos | ✅ | | ✅ | |
| `devices:manage:any` | O mesmo, para qualquer cliente | ✅ | | | |
| `passages:read` | Ver passagens dos próprios dispositivos | ✅ | | ✅ | |
| `passages:read:any` | Ver passagens de todos | ✅ | | | |
| `telemetry:write` | Enviar passagens do próprio dispositivo | | | | ✅ |

Gerenciar as **próprias** sessões (logout, listar, revogar uma sessão sua) e o **próprio MFA** não exige escopo: basta estar autenticado. Por isso essas rotas continuam abertas para o token restrito de quem precisa ativar o MFA.

### Códigos de resposta de acesso

| Situação | Status |
|---|---|
| Sem token, token inválido/expirado, sessão encerrada ou dispositivo revogado | **401** |
| Token válido sem o escopo exigido pela rota | **403** |
| Papel exige MFA e o usuário ainda não ativou (token sem escopos) | **403**, com a mensagem de como ativar |
| Código de MFA errado na segunda etapa do login | **401** (com as tentativas restantes) |
| Código de MFA errado nas rotas de gerenciamento (`enable`, `disable`, `recovery-codes`) | **400** (o token continua válido) |
| Recurso de outra pessoa (sem o escopo `:any`) | **404**, e não 403, para não revelar quais ids existem |
| Excesso de requisições (Kong) | **429** |
| Payload acima de 128 KB (Kong) ou 100 KB (API) | **413** |

### Configuração do Kong (`kong/kong.template.yml`, modo DB-less)

| Rota no Kong | Caminhos | Plugins | Observação |
|---|---|---|---|
| `health` | `GET /health*` | — | Pública |
| `jwks` | `GET /.well-known/jwks.json` | — | Pública |
| `reference` | `GET /reference*` | rate limit 120/min | Documentação; o "Try it out" usa o próprio gateway |
| `auth-login` | `POST /auth/login` | rate limit 10/min e 100/h por IP | Freia tentativas de adivinhar senha |
| `auth-refresh` | `POST /auth/refresh` | rate limit 30/min | Refresh não é JWT: o Kong não valida |
| `auth-mfa-verify` | `POST /auth/mfa/verify` | rate limit 10/min e 60/h por IP | Pública; o `mfa_token` é a credencial (e a API limita a 5 tentativas por token) |
| `auth-mfa` | `/auth/mfa*` | `jwt` (até 24h), rate limit 20/min | Gerenciamento do próprio MFA |
| `devices-claim` | `POST /devices/claim` | rate limit 10/min e 60/h | Pública; o código é a credencial |
| `device-telemetry` | `POST ~/devices/[^/]+/passages$` | `jwt` (até 365 dias), rate limit 120/min | Token de dispositivo |
| `protected` | `/users`, `/clients`, `/jobs`, `/reports`, `/auth/logout*`, `/auth/sessions`, `/devices`, `/passages` | `jwt` (até 24h, só no header `Authorization`), rate limit 300/min | Todas as demais |

Plugins globais:

- `correlation-id`: gera o `X-Request-ID`, repassa à API e devolve ao cliente.
- `opentelemetry`: spans do gateway e propagação W3C `traceparent`.
- `request-size-limiting`: limite de 128 KB.

O serviço `api` tem `retries: 1` (só em falha de conexão), para não duplicar POSTs em caso de timeout.

**Rate limit compartilhado:** nos modos `docker:up` e `docker:infra`, o `kong:setup` (com `KONG_RATE_LIMIT_REDIS_HOST=redis`) troca todos os `rate-limiting` para `policy: redis`, no banco 1 do Redis, com `fault_tolerant`. No Kubernetes, o chart faz o mesmo nos `KongPlugin`. Nos modos TLS e Vault, a contagem é local.

**Uma rota cujo prefixo não esteja em nenhuma rota do Kong responde 404 no gateway**, mesmo existindo na API. Veja os [pontos de atenção](#pontos-de-atenção).

---

## TLS: conexões cifradas e mTLS

O TLS é **opcional e ligado por variáveis**, em cada trecho de forma independente. Sem nenhuma variável de TLS, tudo funciona como antes, em texto puro: é o padrão do desenvolvimento local. O modo 6 (`docker:up:tls`) liga tudo de uma vez.

### O que cada trecho usa

```
cliente ──HTTPS:8443──▶ Kong ──HTTPS + certificado do Kong (mTLS)──▶ API ──TLS + certificado da API (mTLS)──▶ Mongo, Redis, RabbitMQ
                                                                        └──HTTPS (verifica o servidor)──▶ InfluxDB
                                                                        └──OTLP em HTTP (ou HTTPS, se o coletor tiver)──▶ LGTM
```

| Trecho | Como liga | Verificação |
|---|---|---|
| Cliente → Kong | `KONG_PROXY_LISTEN` com `8443 ssl` e `KONG_SSL_CERT`/`KONG_SSL_CERT_KEY` (no `docker-compose.tls.yml`) | O cliente confia na CA (`certs/ca.crt` em desenvolvimento; uma CA pública em produção) |
| Kong → API | `KONG_UPSTREAM_URL=https://...` no `kong:setup` | O Kong verifica o certificado da API (`tls_verify` + `ca_certificates`) e se identifica com o próprio certificado (`client_certificate`) |
| API (servidor) | `SERVER_TLS=true` | Com `SERVER_TLS_CLIENT_AUTH=require`, só aceita clientes com certificado assinado por `SERVER_TLS_CA_FILE`: na prática, só o Kong. O handshake falha antes de chegar ao Express |
| API → MongoDB | `MONGO_TLS=true` (ou `tls=true` na URI, ou `mongodb+srv://`) | CA + certificado de cliente; o `mongod` roda com `requireTLS` e exige certificado |
| API → Redis | `rediss://` (ou `REDIS_TLS=true`) | CA + certificado de cliente; o Redis roda só com a porta TLS e `tls-auth-clients yes` |
| API → RabbitMQ | `amqps://` na `RABBITMQ_URI` (porta 5671) | CA + certificado de cliente; o broker tem `fail_if_no_peer_cert = true` e a porta 5672 fica fechada |
| API → InfluxDB | `https://` na `INFLUX_URL` | CA; o InfluxDB não suporta certificado de cliente |
| API → OTLP | `OTEL_EXPORTER_OTLP_ENDPOINT=https://...` | Variáveis padrão do OpenTelemetry: `OTEL_EXPORTER_OTLP_CERTIFICATE`, `..._CLIENT_CERTIFICATE`, `..._CLIENT_KEY` |

### Variáveis

Cada conexão de saída tem o mesmo conjunto de variáveis, com o prefixo do serviço (`MONGO_`, `REDIS_`, `RABBITMQ_`, `INFLUX_`):

| Variável | Padrão | Descrição |
|---|---|---|
| `<P>_TLS` | `false` | Liga o TLS. O esquema seguro na URL (`rediss://`, `amqps://`, `https://`, `tls=true` no Mongo) também liga |
| `<P>_TLS_CA_FILE` | `TLS_CA_FILE` | CA que assinou o certificado do servidor. Sem nenhuma, valem as CAs do sistema (e `NODE_EXTRA_CA_CERTS`) |
| `<P>_TLS_CERT_FILE` / `<P>_TLS_KEY_FILE` | `TLS_CLIENT_CERT_FILE` / `TLS_CLIENT_KEY_FILE` | Certificado e chave da API como cliente (mTLS), definidos juntos |
| `<P>_TLS_SERVERNAME` | host da URL | Nome esperado no certificado do servidor (SNI), quando diferente do host |
| `<P>_TLS_REJECT_UNAUTHORIZED` | `true` | `false` aceita qualquer certificado: só para diagnóstico |

`TLS_CA_FILE`, `TLS_CLIENT_CERT_FILE` e `TLS_CLIENT_KEY_FILE` são os padrões de todas as conexões: com uma CA interna única, bastam essas três. A variável do serviço prevalece sobre o padrão.

O servidor da API:

| Variável | Padrão | Descrição |
|---|---|---|
| `SERVER_TLS` | `false` | HTTPS em vez de HTTP, na mesma `PORT` |
| `SERVER_TLS_CERT_FILE` / `SERVER_TLS_KEY_FILE` | — | Obrigatórios com `SERVER_TLS=true` |
| `SERVER_TLS_CLIENT_AUTH` | `none` | `require`: exige certificado de cliente (mTLS) |
| `SERVER_TLS_CA_FILE` | — | CA dos certificados de cliente aceitos; obrigatória com `require` |
| `SERVER_TLS_MIN_VERSION` | `TLSv1.2` | `TLSv1.2` ou `TLSv1.3` |

**Validação na inicialização:** a API se recusa a subir quando a configuração é incoerente, em vez de cair silenciosamente para texto puro. Os casos recusados:

- `RABBITMQ_TLS=true` com `amqp://`, ou `INFLUX_TLS=true` com `http://`;
- um `*_TLS_CA_FILE` definido com o TLS daquele serviço desligado;
- certificado de cliente sem a chave;
- `SERVER_TLS_*` definido sem `SERVER_TLS=true`;
- `require` sem CA.

Arquivo ausente ou ilegível gera um erro com o caminho (`TLS: não foi possível ler a CA em ...`). Os logs de conexão dizem se o TLS está ligado: `Conectando ao Redis em rediss://redis:6379 com TLS (CA /app/certs/ca.crt, certificado de cliente)...`.

### Certificados de desenvolvimento

`npm run tls:setup` (requer `openssl`) gera em `certs/` uma CA local e um certificado por serviço, cada um com os nomes pelos quais é acessado:

- os certificados de servidor: `api`, `kong`, `mongo`, `redis`, `rabbitmq` e `influxdb`;
- os nomes alternativos: o nome do serviço, `localhost` e `127.0.0.1`, mais `host.docker.internal` no da API.

Os certificados usam ECDSA P-256 e valem por 825 dias. Cada um serve para servidor e cliente (`serverAuth` + `clientAuth`): o da API é também a identidade dela perante o Mongo, o Redis e o RabbitMQ, e o do Kong é a identidade dele perante a API. O script reaproveita o que ainda vale por mais de 30 dias. `--force` gera tudo de novo.

No `docker-compose.tls.yml`, cada container monta **só o próprio certificado e chave**, mais `ca.crt`. A chave da CA (`certs/ca.key`, 0600) não é montada em nenhum lugar.

### Chamando a API direto

Com `SERVER_TLS_CLIENT_AUTH=require`, chamar a porta 3000 sem certificado falha no handshake. Para depurar, apresente o certificado do Kong:

```bash
curl --cacert certs/ca.crt --cert certs/kong.crt --key certs/kong.key https://localhost:3000/health
```

Pelo gateway: `curl --cacert certs/ca.crt https://localhost:8443/...`. Para o navegador e o Postman, importe `certs/ca.crt` como autoridade confiável. Clientes do Mongo (mongosh, Compass) e do Redis também precisam de um certificado de cliente: use `certs/api.crt`/`certs/api.key`.

### Renovação sem reiniciar

A API relê os certificados sozinha a cada `SECRETS_RELOAD_INTERVAL_MS` (30 s), quando o Vault Agent, o cert-manager ou o certbot os renovam em disco:
- **Certificado do servidor:** as conexões novas usam o novo e as abertas seguem até fechar.
- **Certificados de cliente** (Mongo, Redis, RabbitMQ, InfluxDB): a conexão afetada é refeita (veja [Conexões e reconexões](#conexões-e-reconexões)).
- **Forçar na hora:** `kill -HUP <pid>` (ou `docker compose kill -s SIGHUP api`) troca o do servidor imediatamente.
- **Se a leitura falhar:** o anterior continua em uso e o erro vai para o log.

### Em produção

- Use certificados da sua PKI e uma CA pública ou corporativa no Kong. O caminho previsto é a PKI do Vault ([Segredos e certificados com Vault](#segredos-e-certificados-com-vault-opentofu)), com certificados de 72 h renovados pelo Agent. Os de `tls:setup` são só para desenvolvimento.
- Feche a porta 8000 (HTTP) do Kong, ou redirecione para HTTPS (`https_redirect_status_code` nas rotas).
- Mantenha `SERVER_TLS_CLIENT_AUTH=require`: assim só o gateway fala com a API, mesmo dentro da rede.
- Serviços gerenciados (Atlas, ElastiCache, Amazon MQ, InfluxDB Cloud) normalmente usam certificados de CAs públicas: basta o esquema seguro na URL, sem `*_CA_FILE`.

---

## Segredos e certificados com Vault (OpenTofu)

Em produção (Kubernetes), nenhum segredo fica em variável de ambiente, imagem ou repositório.
- **Origem:** tudo vem do **Vault**, configurado como código pelo repositório **`platform-infra`** (módulos OpenTofu `vault/modules`; o serviço é declarado em `vault/projects/matrixgrid.yaml`).
- **Entrega:** o **Vault Agent** grava os segredos como arquivos, e a API os lê pela convenção `<VAR>_FILE`.
- **Ambiente local:** o modo 7 (`npm run docker:up:vault`) usa **os mesmos módulos**, copiados em `dev/vault/modules`, num ambiente chamado `local`. Os caminhos são os mesmos do Kubernetes; só muda o prefixo.

```
 platform-infra (plataforma)                       este repositório (serviço)
 ──────────────────────────                        ──────────────────────────
 vault/modules  ── cópia (npm run vault:sync-modules) ──► dev/vault/modules ──► dev/vault/main.tf (ambiente "local")
 vault/live/{nonprod,prd} + projects/matrixgrid.yaml     deploy/values.yaml: vault.files (templates do Agent)
        │                                                       │
        ▼                                                       ▼
 Vault dev/hml/prd ◄── Agent Injector (chart base) ◄── mesmos templates ──► container vault-agent (local)
```

### Convenção de caminhos (papel `matrixgrid-api-clean-architecture`)

| Segredo | Caminho no Vault | Arquivo entregue | Variável da API |
|---|---|---|---|
| Usuário temporário do MongoDB | `<env>/database/creds/<papel>` | `mongo-username`, `mongo-password` | `MONGO_USERNAME_FILE`, `MONGO_PASSWORD_FILE` |
| Usuário temporário do RabbitMQ | `<env>/rabbitmq/creds/<papel>` | `rabbitmq-username`, `rabbitmq-password` | `RABBITMQ_USERNAME_FILE`, `RABBITMQ_PASSWORD_FILE` |
| Senha do Redis, token do InfluxDB, senha do admin | `<env>/kv/data/matrixgrid/api-clean-architecture/static` | `redis-password`, `influx-token`, `admin-password` | `REDIS_PASSWORD_FILE`, `INFLUX_TOKEN_FILE`, `ADMIN_PASSWORD_FILE` |
| Chaves dos JWTs | `<env>/kv/data/matrixgrid/api-clean-architecture/jwt` | `jwt-private-key`, `jwt-public-key` | `JWT_PRIVATE_KEY_PATH`, `JWT_PUBLIC_KEY_PATH` |
| CA raiz | `pki-root/cert/ca` | `ca-cert` | `TLS_CA_FILE`, `SERVER_TLS_CA_FILE` |
| Certificado da API (72 h, renovado sozinho) | `<env>/pki/issue/<papel>` | `api-cert`, `api-key` | `SERVER_TLS_*`, `TLS_CLIENT_*` |
| Cifra do MFA | `<env>/transit`, chave `<papel>` | (proxy do Agent) | `MFA_CIPHER=vault-transit`, `VAULT_TRANSIT_MOUNT`, `VAULT_TRANSIT_KEY` |

`<env>` é `dev`, `hml` ou `prd` no Kubernetes e `local` aqui.

### Como a API recebe

- **Sem SDK do Vault na aplicação:** a API não conhece o Vault, exceto pelo Transit. Ela lê arquivos com a convenção `<VAR>_FILE`.
  - Variáveis suportadas: `MONGO_URI`, `MONGO_USERNAME`, `MONGO_PASSWORD`, `REDIS_URL`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `RABBITMQ_URI`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, `INFLUX_TOKEN`, `ADMIN_PASSWORD`, `MFA_ENCRYPTION_KEY` e `MFA_ENCRYPTION_PREVIOUS_KEYS`.
  - Os certificados e as chaves dos JWTs já eram caminhos de arquivo.
- **Funciona com qualquer fonte de arquivos:** Vault Agent, Vault Secrets Operator, External Secrets ou um Secret comum.
- **Troca sem reiniciar:** quando o Agent grava valores novos, a API percebe em até `SECRETS_RELOAD_INTERVAL_MS` e refaz só a conexão afetada (veja [Conexões e reconexões](#conexões-e-reconexões)).
- **Transit pelo proxy do Agent:** `VAULT_ADDR` aponta para o Agent (no pod, `http://127.0.0.1:8200`), que injeta o token.

### Os templates do Agent: fonte única

Os templates ficam em `vault.files` do [`deploy/values.yaml`](deploy/values.yaml). Eles são usados:
- pelo chart base, nas anotações do Agent Injector;
- pelo `scripts/vault.local.ts`, que gera a configuração do container `vault-agent`.

Os marcadores (`@@VAULT_ENV@@`, `@@VAULT_ROLE@@`, `@@SECRETS_DIR@@`, nomes e validade do certificado) são preenchidos por quem usa.

**Segredo novo:** template em `vault.files`, variável em `env` e, se for estático, o nome no `projects/matrixgrid.yaml` da plataforma.

### Ambiente local, passo a passo (`scripts/vault.local.ts`)

1. Recria o container `vault` (modo dev, em memória, token `dev-root-token`).
2. Gera `.vault/agent.hcl` e `.vault/templates/` a partir de `vault.files` do `deploy/values.yaml`, com o ambiente `local`.
3. Aplica `dev/vault` (módulos da plataforma) com o estado em `.vault/`, descartado a cada subida. O OpenTofu grava:
   - os certificados dos serviços em `certs/`, com os mesmos nomes do `tls:setup`;
   - o AppRole do Agent em `.vault/approle`;
   - a chave pública dos JWTs.
4. Recria Mongo (com autenticação e keyfile, volume `mongo-vault-data`), Redis (com senha), RabbitMQ e InfluxDB com os certificados novos. O healthcheck do Mongo cria o administrador que o Vault usa. Neste modo o Mongo aceita TLS sem certificado de cliente: o Vault autentica com usuário e senha (com certificado de cliente, o plugin do Vault usaria X.509), e a API continua apresentando o dela.
5. Sobe o `vault-agent` (AppRole `approle-local`), que grava `.vault/secrets/*`.
6. Roda a migração de índices (`src/main/migrate.ts`), como o job do deploy.
7. Gera o `kong.yml` (upstream HTTPS, chave pública do Vault) e sobe LGTM, API e Kong.

**Módulos desatualizados?** `npm run vault:sync-modules` copia a versão atual de `../platform-infra/vault/modules` (ou de `PLATFORM_INFRA_DIR`).

**Inspecionar:**
- interface do Vault em `http://localhost:8200` (token `dev-root-token`);
- `docker compose -f docker-compose.yml -f docker-compose.tls.yml -f docker-compose.vault.yml logs vault-agent`;
- `ls .vault/secrets`.

O log da API mostra o usuário temporário: `Conectando ao MongoDB em ... como "v-approle-matrixgrid-..."`.

---

## Implantação no Kubernetes (Helm)

Este repositório **não tem chart próprio**. A implantação é dividida entre três repositórios:

| Repositório | O que tem sobre este serviço |
|---|---|
| **este** (`node-api-clean-architecture`) | [`deploy/values.yaml`](deploy/values.yaml): o contrato do serviço com o chart base (variáveis, arquivos e templates do Vault, migração, rotas do Kong, alertas próprios) |
| **`platform-infra`** | o chart base `charts/microservice` (publicado como OCI), os módulos do Vault e a declaração do serviço em `vault/projects/matrixgrid.yaml` |
| **`matrixgrid-gitops`** | `apps/api-clean-architecture/`: os values de cada ambiente (digest da imagem, host, réplicas, chave pública dos JWTs) e a revisão deste repositório em uso |

O Argo CD (cluster de governança) monta cada ambiente com essas três fontes: chart base + `deploy/values.yaml` (na revisão promovida) + values do ambiente.

**O que o chart base cria para o serviço:**

| Recurso | O que faz |
|---|---|
| `Deployment` | API com o Vault Agent injetado. Probes na porta de saúde (8081, HTTP): `/health/live` e `/health/ready`. `preStop` de 5 s. Usuário 1000, sistema de arquivos somente leitura, sem *capabilities*, `RuntimeDefault` |
| `Job` `api-clean-architecture-migrate` | Hook `pre-install,pre-upgrade`: `node src/main/migrate.ts` antes de cada versão; as réplicas sobem com `MONGO_AUTO_INDEX=false` |
| `Service` + `Ingress`/`KongPlugin`/`KongConsumer` | Uma rota por item de `kong.routes`: JWT, rate limit no Redis, correlation id, limite de payload e traces; upstream HTTPS com mTLS |
| `HorizontalPodAutoscaler` / `PodDisruptionBudget` / `NetworkPolicy` | 2 a 6 réplicas; ao menos 1 disponível; só Kong, monitoramento e o próprio projeto alcançam a API |
| `PrometheusRule` | SLOs (gerados pelo chart) e os alertas próprios de `metrics.prometheusRule.extraRules` |

**Validação local do contrato:** `npm test` inclui `test/unit/helm.test.ts`, que renderiza o chart base com `deploy/values.yaml` e os ambientes de `test/fixtures/helm/`, validando o env gerado com o próprio `loadEnv` da API. O chart é procurado em `PLATFORM_CHART_DIR` ou em `../platform-infra/charts/microservice`; sem ele, o teste é ignorado.

**Fluxo de entrega** (git-flow, componentes de `ci-templates`, ver [Integração contínua](#integração-contínua)):

1. Merge request: qualidade, segurança, Helm, integração (runner dedicado).
2. `develop`: imagem construída **uma vez** (Buildah, Trivy, SBOM, cosign) e promovida para **dev** (commit no GitOps).
3. `release/*`: nova imagem promovida para **homologação** (MR no GitOps).
4. Tag `vX.Y.Z` em `main`: MR copiando o digest de homologação para **produção**, com aprovação (`CODEOWNERS`) e sync manual no Argo CD.

---

## Rotas

Todas as respostas trazem `X-Request-ID`. Os erros seguem `{ "code": "...", "message": "...", "issues"?: [...] }`. A coluna **Rota Kong** indica a rota que atende o caminho no gateway.

### Sistema

| Método e caminho | Acesso | Rota Kong | O que faz |
|---|---|---|---|
| `GET /health`, `GET /health/live` | pública | `health` | Liveness: o processo está de pé (não consulta dependências) |
| `GET /health/ready` | pública | `health` | Readiness: 200 ou 503 com o estado de cada dependência |
| `GET /.well-known/jwks.json` | pública | `jwks` | Chave pública (JWKS) para outros serviços validarem os tokens |
| `GET /reference`, `/reference/openapi.json`, `/reference/openapi.yaml` | pública (se `API_DOCS_ENABLED`) | `reference` | Swagger UI e documento OpenAPI |

### Autenticação e sessões

| Método e caminho | Acesso | O que faz |
|---|---|---|
| `POST /auth/login` | pública | `{ email, password }` → `{ access_token, token_type, expires_in, refresh_token, refresh_expires_in }`; abre uma sessão. Com MFA ativo → `{ mfa_required: true, mfa_token, mfa_methods, expires_in }` |
| `POST /auth/mfa/verify` | pública | `{ mfa_token, code }` → par de tokens; segunda etapa do login com MFA (código do aplicativo ou de recuperação) |
| `POST /auth/refresh` | pública | `{ refresh_token }` → novo par; o refresh token antigo deixa de valer (reuso revoga a sessão) |
| `POST /auth/logout` | autenticado | Encerra a sessão do token (204) |
| `POST /auth/logout-all` | autenticado | Encerra todas as sessões do usuário → `{ revoked }` |
| `GET /auth/sessions` | autenticado | Sessões ativas do usuário, com `current: true` na do token e `amr` (se passou pelo segundo fator) |
| `DELETE /auth/sessions/:id` | autenticado | Encerra uma sessão própria (alheia → 404; qualquer uma com `sessions:revoke:any`) |
| `DELETE /users/:id/sessions` | `sessions:revoke:any` | Derruba todas as sessões do usuário (ex.: conta comprometida) |

### MFA

| Método e caminho | Acesso | O que faz |
|---|---|---|
| `GET /auth/mfa` | autenticado | `{ enabled, enabled_at, recovery_codes_remaining, required }` |
| `POST /auth/mfa/setup` | autenticado | Gera o segredo, ainda inativo → `{ secret, otpauth_url, expires_in }` (409 se já ativo) |
| `POST /auth/mfa/enable` | autenticado | `{ code }` do aplicativo → `{ recovery_codes }`; ativa, eleva a sessão atual e encerra as outras |
| `POST /auth/mfa/disable` | autenticado | `{ code }` do aplicativo ou de recuperação → 204 |
| `POST /auth/mfa/recovery-codes` | autenticado | `{ code }` do aplicativo → `{ recovery_codes }` novos; os anteriores deixam de valer |
| `DELETE /users/:id/mfa` | `mfa:reset:any` | Desliga o MFA do usuário e encerra as sessões dele → 204 |

### Usuários

| Método e caminho | Escopo | O que faz |
|---|---|---|
| `POST /users` | `users:create` | Cadastra `{ name, email, password, role: "manager" \| "client" }` (201; e-mail repetido → 409). Publica `UserCreatedEvent` |
| `GET /users` | `users:read:any` | Lista todos, com query string |
| `GET /users/me` | `users:read` | Cadastro do usuário do token |
| `GET /users/:id` | `users:read` | O próprio id; qualquer id com `users:read:any` (senão 404) |
| `GET /clients` | `clients:read` | Lista só clientes (o filtro de papel não pode ser sobrescrito), com query string |

### Jobs (relatórios)

| Método e caminho | Escopo | O que faz |
|---|---|---|
| `POST /reports` | `jobs:create` | `{ clientId, month: "AAAA-MM" }` → **202** com o job `pending` e `Location: /jobs/<id>`; o gestor vem do token |
| `GET /jobs` | `jobs:read` | Gestor vê os que criou, cliente os associados a ele, `jobs:read:any` vê todos; com query string |
| `GET /jobs/:id` | `jobs:read` | Mesma regra; job de outra pessoa → 404 |

### Dispositivos e passagens

| Método e caminho | Escopo | O que faz |
|---|---|---|
| `POST /clients/:clientId/pairing-codes` | `devices:manage` | O próprio cliente (ou admin, com `:any`) gera um código de pareamento (10 min, uso único) |
| `POST /devices/claim` | pública | A ESP32 troca `{ code, hardwareId, firmware }` por `{ device_id, client_id, access_token }`. Publica `DevicePairedEvent` |
| `GET /devices` | `devices:read` | Dispositivos do cliente (admin: todos), com query string |
| `DELETE /devices/:id` | `devices:manage` | Revoga o dispositivo; o token dele deixa de valer na hora. Publica `DeviceRevokedEvent` |
| `POST /devices/:deviceId/passages` | `telemetry:write` (token do dispositivo) | Lote de 1 a 500 passagens → `202 { accepted }` |
| `GET /passages` | `passages:read` | Passagens dos dispositivos do cliente (admin: todas), com query string |
| `GET /passages/summary` | `passages:read` | Contagem `in`/`out`/`unknown` por janela de tempo |

### Exposição: o que fica público e por onde

| Porta | Serviço | Exposição |
|---|---|---|
| 8000 | Kong (proxy) | **Única porta para clientes** (HTTP) |
| 8443 | Kong (proxy HTTPS) | Só no modo com TLS; em produção, a única aberta |
| 8001 | Kong Admin API | Só em `127.0.0.1`; nunca expor |
| 3000 | API | No modo 3, não é publicada; no modo 2, é o processo no host |
| 9464 | `/metrics` da API | Rede interna / Prometheus |
| 3001, 4318 | Grafana / OTLP | Só local (desenvolvimento) |
| 27017, 6379, 8086, 5672, 15672 | Mongo, Redis, Influx, RabbitMQ | Só em `127.0.0.1`, sem autenticação no Mongo/Redis (uso local) |
| 5671, 15671 | RabbitMQ (AMQPS e interface em HTTPS) | Só no modo com TLS, no lugar de 5672 e 15672 |
| 8200 / 8100 | Vault (dev) / proxy do Vault Agent | Só no modo Vault, em `127.0.0.1` |
| 8081 | Porta só de saúde da API (`HEALTH_PORT`) | No Kubernetes, para as probes do kubelet; não é exposta pelo Kong |

O RabbitMQ é uma **segunda porta de entrada**: os recursos RPC (`users.find`, `users.findone`, `jobs.find`) não passam pelo Kong nem exigem token.

---

## Listagens: query string

`GET /users`, `/clients`, `/jobs`, `/devices` e `/passages` usam o [query-strings-parser](https://github.com/nutes-uepb/query-strings-parser):

| Exemplo | Significado |
|---|---|
| `?status=succeeded` | igual a |
| `?status=pending,running` | um dos valores (OU) |
| `?name=*ana*` | contém (`ana*` começa com, `*ana` termina com), sem diferenciar maiúsculas e acentos |
| `?createdAt=gte:2026-10-01` | operadores `gt`, `gte`, `lt`, `lte`, `ne` |
| `?start_at=2026-10-01&end_at=2026-11-01` | intervalo no campo de data do recurso (o `end_at` não entra) |
| `?period=7d` | últimos 7 dias (`d`, `w`, `m`, `y`) |
| `?sort=-createdAt,status` | ordenação (`-` = decrescente) |
| `?fields=id,status,clientId` | campos da resposta |
| `?page=2&limit=10` | paginação (padrão 20, máximo 100); total no header `X-Total-Count` |

- **Whitelist por recurso:** cada recurso declara o que pode ser filtrado, ordenado e selecionado (`src/application/query/*.query.schema.ts`). Qualquer outro campo, operador ou valor fora do tipo responde 400, com a lista de problemas em `issues`. Isso impede, por exemplo, filtrar por `passwordHash` ou injetar operadores do Mongo.
- **Sem regex:** metacaracteres de regex são recusados (só `*` é curinga), para evitar ReDoS.
- **A restrição de acesso é combinada com `$and`** ao filtro da query string, então nenhum filtro amplia o que o usuário pode ver.
- **O middleware da biblioteca não é usado:** ele sobrescreve `req.query`, que é somente leitura no Express 5. A API chama `parser()` diretamente (`presentation/http/query/list.query.parser.ts`).

---

## Jobs assíncronos e tarefas de background

### Jobs

```
POST /reports ──► JobService.submit: valida payload (schema do tipo) e cliente ──► grava Job(pending)
               ──► enfileira (em processo ou BullMQ) ──► 202 + Location: /jobs/<id>
worker ──► run.job: pending → running → handler (background/jobs/handlers.ts) → succeeded | failed
cliente ──► GET /jobs/<id> (polling) até succeeded/failed
```

- **Tipos:** cada tipo (hoje `report.generate`) tem um schema de payload em `domain/validator/job.validator.ts` e um handler em `background/jobs/handlers.ts`. O handler chama um service da aplicação.
- **Em processo:** concorrência 2. Na inicialização, `recover()` recoloca na fila os jobs que ficaram `running` por queda (só para instância única).
- **BullMQ:** 3 tentativas com backoff; jobs travados (*stalled*) são recuperados pelo próprio BullMQ; qualquer instância consome.
- **Limpeza:** a task `purge-old-jobs` remove jobs finalizados há mais de 7 dias (na inicialização e às 03:00).
- **Métricas:** `jobs_completed_total` (por tipo e status) e `jobs_duration_seconds`.

### Tasks de background

`BackgroundTask { name, runOnStartup?, schedule? (cron de 5 campos), run(signal) }`, registradas em `background/tasks/index.ts`. O fuso é `America/Recife`.

| Task | Quando | O que faz |
|---|---|---|
| `purge-old-jobs` | ao iniciar e `0 3 * * *` | Remove jobs finalizados há mais de 7 dias |
| `purge-ended-sessions` | `30 3 * * *` | Remove sessões encerradas há mais de 7 dias |

Com BullMQ, cada execução agendada roda em **uma única instância**. No modo em processo, cada instância roda a sua.

---

## Dispositivos (ESP32) e passagens

Um sensor na ESP32 (ex.: dois feixes infravermelhos ou um VL53L1X) detecta que alguém cruzou uma passagem e envia o evento para a API, que grava no InfluxDB.

### Pareamento

```
cliente                          API                                  ESP32
   │ POST /clients/:id/pairing-codes │                                    │
   │ ───────────────────────────────>│  gera "K7QM-9XRT" (10 min, uso único)│
   │ <─── { code, expires_in } ──────│                                    │
   │      digita o código na ESP32 ──────────────────────────────────────>│
   │                                 │<── POST /devices/claim { code } ───│
   │                                 │─── { device_id, client_id,  ──────>│ guarda no NVS
   │                                 │      access_token }                │
   │                                 │<── POST /devices/:id/passages ─────│ Authorization: Bearer <token>
   │                                 │    { clientId, events: [...] }     │
```

- **Código:** 8 caracteres, sem os ambíguos (0/O, 1/I/L). Aceita minúsculas, com ou sem hífen, e o banco guarda só o hash. Expira em `PAIRING_CODE_TTL_SECONDS` e vale uma vez só (troca atômica). O Kong limita `/devices/claim` a 10 tentativas por minuto por IP.
- **`client_id`:** o valor devolvido vai no payload de cada envio, e a API confere se é o mesmo do dispositivo (senão, 403). Quem autentica é o **token do dispositivo**: o id do cliente não é segredo e, sozinho, permitiria que qualquer um gravasse dados em nome de outro cliente.
- **Token do dispositivo:** só serve para `POST /devices/:próprio-id/passages`. O Kong o valida na rota de envio e o recusa nas demais, que aceitam no máximo 24h de validade.
- **Revogação imediata:** a API confere o dispositivo a cada envio. Parear de novo o mesmo hardware (`hardwareId`, o MAC) revoga o registro anterior (`DeviceRevokedEvent` com `reason: replaced_by_new_pairing`). Tudo isso acontece em uma transação.

### Envio (`POST /devices/:deviceId/passages`)

```json
{
  "clientId": "4bd20e50-de0f-4152-b8c8-bf1e15b3ae64",
  "events": [
    { "eventId": "8f14e45f-ceea-4c7e-9b3e-1f2a3b4c5d6e", "occurredAt": "2026-11-16T21:43:12.481Z", "direction": "in", "sequence": 1532 }
  ],
  "device": { "firmware": "1.2.0", "uptimeSeconds": 86400, "rssi": -61 }
}
```

| Campo | Regra |
|---|---|
| `clientId` | UUID; precisa ser o cliente do dispositivo |
| `events` | De 1 a 500 eventos (a ESP32 guarda offline e envia em lote) |
| `eventId` | UUID gerado na ESP32: reenviar o mesmo evento não duplica |
| `occurredAt` | ISO 8601 com fuso; até 5 min no futuro (relógio por NTP) e até 30 dias no passado |
| `direction` | `in`, `out` ou `unknown` |
| `sequence` | Opcional; contador crescente (mostra eventos perdidos) |
| `device` | Opcional: saúde do dispositivo |

A resposta é `202 { "accepted": n }`. A ESP32 pode então apagar do buffer local tudo o que enviou.

### Modelo no InfluxDB (bucket `sensors`)

| Medição | Tags (indexadas) | Fields | Tempo |
|---|---|---|---|
| `passage` | `clientId`, `deviceId`, `direction` | `count=1i`, `eventId`, `sequence`, `receivedAtMs` | `occurredAt` |
| `device_status` | `clientId`, `deviceId` | `firmware`, `uptimeSeconds`, `rssi` | recebimento |

Um ponto é identificado por medição, tags e tempo, então reenviar o mesmo evento sobrescreve o ponto (gravação idempotente). O `eventId` fica em field para não aumentar a cardinalidade. A retenção do bucket apaga dados com mais de 400 dias.

### Consulta

- **Lista:** `GET /passages?deviceId=...&direction=in&start_at=2026-11-01T00:00:00&end_at=2026-11-02T00:00:00&sort=-occurredAt&page=1&limit=50`, com o total em `X-Total-Count`.
- **Resumo:** `GET /passages/summary?window=1h&start_at=...&deviceId=...` devolve `{ window, windows: [{ start, in, out, unknown }] }`, com zero nas janelas sem evento.
  - Sem início, considera as últimas 24h, e o fim é limitado ao instante atual.
  - São no máximo 1000 janelas, e o `window` vai de `1m` a `31d`.
- **Filtros em Flux:** viram Flux com os valores escapados pela biblioteca oficial e já validados (UUIDs e enums). Sem InfluxDB, o armazenamento em memória reproduz o mesmo comportamento, inclusive as janelas.

---

## Barramento de eventos (RabbitMQ)

A comunicação com outros microsserviços usa o `amqplib`, atrás da porta `IEventBus` (`application/port/event.bus.ts`). Com `EVENT_BUS_DRIVER=memory`, um barramento dentro do processo faz o mesmo papel.

| Papel | Onde | Detalhes |
|---|---|---|
| Publicar | Services gravam no outbox (`IOutbox`); o relay chama `eventBus.publish` | Exchange `topic` durável, mensagem persistente e confirmação do broker (*publisher confirms*) |
| Assinar | `presentation/eventbus/subscribers.ts` | Cada subscriber declara `eventName`, `exchange` e `routingKey` (aceita `*` e `#`) e chama um service. Fila durável `<APP_NAME>`. O ack vem depois do processamento; se o handler falhar, a mensagem é descartada com log |
| Oferecer RPC | `presentation/eventbus/rpc.resources.ts` | Exchange `direct` `<APP_NAME>.rpc`. Recursos: `users.find(query)`, `users.findone(id)`, `jobs.find(query)`. As consultas aceitam a mesma query string das rotas, validada pelo mesmo schema |
| Chamar RPC | `eventBus.executeResource(servico, recurso, ...params)` | Chama `<servico>.rpc` por *direct reply-to*. Recurso inexistente falha na hora; sem resposta, falha após `RABBITMQ_RPC_TIMEOUT_MS` |

Exemplo de outro serviço chamando esta API: `executeResource('api-clean-architecture', 'users.find', '?role=client&fields=name,email')`. Erros, como query string inválida, voltam como erro para quem chamou, em vez de virar *timeout*.

- **Compatível com a `amqp-client-node`:** mesmo formato de mensagem (JSON), mesma convenção de RPC (`{ resource_name, handle }` e `type: "error"` nas falhas) e mesmos argumentos de fila. O teste `test/integration/rabbitmq.test.ts` usa a biblioteca dos serviços antigos para provar as duas direções.
- **Duas conexões:** `publish` (publicação e cliente RPC) e `consume` (subscribers e servidor RPC). Assim, um consumidor lento não atrasa as publicações.
- **Reconexão própria, para sempre:** a espera dobra até 15 s. Cada tentativa é registrada com o motivo real (recusa, credenciais, vhost, fila incompatível), e exchanges, filas, ligações e consumidores são refeitos a cada reconexão.

### Outbox transacional

Os services nunca publicam direto no barramento: eles gravam o evento na coleção `outbox_events` **na mesma transação** do dado que mudou (`IUnitOfWork`), e um relay publica em seguida.

```
POST /users ──► transação { insert users, insert outbox_events } ──► 201
                                         │
                         relay (a cada evento novo ou 1 s) ──► RabbitMQ (confirmado) ──► marca como enviado
```

- **Garantias:** o evento só existe se o dado foi gravado, e nunca se perde com o RabbitMQ fora do ar ou com a API reiniciando. Há novas tentativas com espera crescente, até 5 minutos.
- **"Pelo menos uma vez":** se a instância cair entre publicar e marcar como enviado, o evento sai de novo com o mesmo `messageId`. Os consumidores descartam repetidos pelo `messageId` (ou pelo `audit.id`).
- **Várias instâncias:** cada evento é reservado por uma só (`findOneAndUpdate` atômico), sem envio duplicado.
- **Trace contínuo:** o relay publica dentro do trace de quem gravou o evento.
- **Limpeza e monitoramento:** eventos enviados ficam 7 dias (índice TTL). Pendentes e idade do mais antigo aparecem em `/health/ready` e nas métricas.
- **Replica set obrigatório para atomicidade:** o compose já sobe o Mongo com `--replSet rs0`, e a URI usa `?directConnection=true`. Com um `mongod` avulso, a API funciona, mas avisa no log que dado e evento não serão atômicos.
- **Implementação:** `transactionAsyncLocalStorage` do Mongoose repassa a sessão da transação a todas as operações do callback, sem mudar nenhum repositório.

Eventos publicados por este serviço:

| Exchange | Routing key | Evento | Quando |
|---|---|---|---|
| `users` | `users.created` | `UserCreatedEvent` | Admin cadastra gestor ou cliente |
| `devices` | `devices.paired` | `DevicePairedEvent` | ESP32 pareada |
| `devices` | `devices.revoked` | `DeviceRevokedEvent` (`reason`: `revoked_by_user` ou `replaced_by_new_pairing`) | Cliente revoga, ou o mesmo hardware é pareado de novo |
| `audit` | `audit.request` | `RequestAuditEvent` | Cada requisição (ver abaixo) |

### Mensagens com falha (DLQ)

Quando um subscriber falha, a mensagem é processada de novo até `RABBITMQ_SUBSCRIBER_ATTEMPTS` vezes (3), com espera crescente (200 ms, 400 ms...). Se continuar falhando, ou se não for JSON, ela vai para a fila **`<APP_NAME>.dlq`**, com a origem e o motivo nos headers, e a original é confirmada:

| Header | Conteúdo |
|---|---|
| `x-dlq-reason` | Mensagem do erro (ou `invalid_json`) |
| `x-dlq-attempts` | Tentativas feitas |
| `x-dlq-exchange` / `x-dlq-routing-key` | De onde veio |
| `x-dlq-failed-at` / `x-dlq-service` | Quando e em qual serviço |

- **Por que uma fila do próprio serviço** (e não uma *dead-letter exchange* nos argumentos da fila): mudar os argumentos de uma fila existente dá `PRECONDITION_FAILED`, tanto em volumes antigos quanto nos serviços que usam a `amqp-client-node`.
- **Monitoramento:** a métrica `eventbus_dead_lettered_total` alimenta um painel e um alerta.
- **Reprocessar:** corrija a causa e mova as mensagens de volta pela interface do RabbitMQ (*Queues* > `<APP_NAME>.dlq` > *Move messages*, com o plugin Shovel) ou republique na exchange de origem.

### Auditoria

A cada requisição, a API grava no outbox e publica um `RequestAuditEvent` na exchange `audit`, com routing key `audit.request`. Ficam de fora os caminhos de `AUDIT_IGNORE_PATHS` (por padrão `/health`, `/.well-known` e `/reference`). O serviço de auditoria assina com uma fila ligada a `audit.#`.

```json
{
  "event_name": "RequestAuditEvent",
  "timestamp": "2026-11-17T14:17:22.904Z",
  "audit": {
    "id": "765af448-...",
    "service": "api-clean-architecture",
    "request_id": "fafa1770-...",
    "actor": { "id": "9e99...", "role": "manager", "session_id": "4c1e..." },
    "request": {
      "method": "POST", "path": "/reports", "route": "/reports", "params": {}, "query": {},
      "body": { "clientId": "...", "month": "2026-10" },
      "ip": "172.18.0.1", "user_agent": "Mozilla/5.0 ..."
    },
    "response": { "status_code": 202, "body": { "id": "...", "status": "pending" } },
    "started_at": "2026-11-17T14:17:22.769Z",
    "finished_at": "2026-11-17T14:17:22.903Z",
    "duration_ms": 134
  }
}
```

- **Quem:** `actor` sai do token (usuário ou dispositivo). Vem `null` no login e nas requisições recusadas com 401. As recusas (401, 403, 404 e 400 de JSON malformado) também são auditadas.
- **Segredos:** senhas, tokens (`access_token`, `refresh_token`, `Authorization`) e o código de pareamento viram `[REDACTED]` antes de sair da API.
- **Tamanho:** corpos acima de `AUDIT_MAX_BODY_BYTES` vão só com o tamanho (`{ "_truncated": true, "_size_bytes": ... }`).
- **Correlação:** `request_id` é o `X-Request-ID` do Kong (ou um novo, se a chamada vier direto) e permite cruzar os logs do gateway, da API e da auditoria.
- **Duplicatas:** `audit.id` é único por evento; o consumidor descarta repetidos pelo `id`.
- **Desligar:** `AUDIT_ENABLED=false`.

---

## Saúde e indisponibilidade

| Rota | Pergunta | Uso |
|---|---|---|
| `GET /health/live` (e `/health`) | O processo está de pé? Não consulta nada | `HEALTHCHECK` do Docker / *liveness probe*: se falhar, reinicia o container |
| `GET /health/ready` | Consegue atender? 200 ou 503, com o estado de cada dependência | Balanceador / *readiness probe*: se falhar, para de mandar tráfego, sem reiniciar |

```json
{ "status": "ready", "checks": {
  "mongodb":  { "status": "up", "critical": true,  "latency_ms": 3, "details": { "transactions": true } },
  "redis":    { "status": "up", "critical": true,  "latency_ms": 1, "details": { "jobs:queue": "ready", "...": "..." } },
  "influxdb": { "status": "up", "critical": false, "latency_ms": 1 },
  "rabbitmq": { "status": "up", "critical": false, "latency_ms": 1, "details": { "publish": true, "consume": true } },
  "outbox":   { "status": "up", "critical": false, "latency_ms": 3, "details": { "pending": 0, "oldestAgeSeconds": 0 } },
  "vault":    { "status": "up", "critical": false, "latency_ms": 2, "details": { "transit_key_version": 1 } } } }
```

- **Críticas:** MongoDB e Redis. Se uma delas cair, a instância deixa de estar pronta.
- **Não críticas:** InfluxDB, RabbitMQ, outbox e Vault (com `MFA_CIPHER=vault-transit`) aparecem no relatório sem tirar a instância do ar. O outbox fica `down` se um evento estiver parado há mais de 5 minutos.
- **Porta só de saúde:** com `HEALTH_PORT`, as três rotas também respondem em HTTP nessa porta, sem TLS. É o que as probes do Kubernetes usam quando a porta principal exige certificado de cliente.
- **Tempo máximo:** cada verificação tem 2 s; uma dependência travada conta como `down`.
- **503, não 500:** banco, fila ou barramento indisponível vira `503 { "code": "UNAVAILABLE" }` com `Retry-After: 5`, registrado como `warn`, sem stack. O 500 fica reservado para bugs. A infraestrutura reconhece os erros dos drivers (`infrastructure/resilience/unavailable.ts`).

### Conexões e reconexões

| Dependência | Na inicialização | Durante a execução |
|---|---|---|
| MongoDB | Tenta até conseguir (espera dobra até 15 s); a API só aceita tráfego depois | O driver reconecta sozinho; queda, tentativas (no máximo uma a cada 5 s) e retorno vão para o log |
| Redis | Espera as 4 conexões (filas e workers de jobs e tasks) | O ioredis reconecta; queda, tentativas (com o último erro) e retorno vão para o log, por conexão |
| InfluxDB | Não bloqueia: um `GET /ping` periódico registra a conexão | `ping` a cada 15 s (5 s enquanto fora); falhas de gravação também vão para o log |
| RabbitMQ | Não bloqueia: conecta em segundo plano, registrando o motivo de cada falha | Reconexão própria, para sempre, refazendo a topologia; vale para cada uma das duas conexões |

**Credenciais e certificados novos, sem reiniciar.** O `SecretFileWatcher` relê, a cada `SECRETS_RELOAD_INTERVAL_MS` (30 s), os arquivos de que cada conexão depende: `<VAR>_FILE` e certificados.

| Conexão | O que relê | Como reconfigura |
|---|---|---|
| MongoDB | `MONGO_USERNAME_FILE`, `MONGO_PASSWORD_FILE` e os arquivos de TLS | Fecha e reabre a mesma conexão (os models continuam ligados a ela) |
| Redis | `REDIS_USERNAME_FILE`, `REDIS_PASSWORD_FILE` e os arquivos de TLS | Atualiza as opções e refaz cada conexão do ioredis (o BullMQ não percebe) |
| RabbitMQ | `RABBITMQ_USERNAME_FILE`, `RABBITMQ_PASSWORD_FILE` e os arquivos de TLS | Fecha as duas conexões; a reconexão já usa os valores novos e refaz a topologia |
| InfluxDB | `INFLUX_TOKEN_FILE` e os arquivos de TLS | Cria um cliente novo; o anterior termina o que tinha |
| Servidor HTTPS | Certificado, chave e CA do servidor | Troca o contexto TLS; as conexões novas usam o certificado novo, como o `SIGHUP` |

- **Comparação por conteúdo, não por data:** os volumes do Kubernetes trocam os arquivos por link simbólico.
- **Falha na reconfiguração:** se ela falhar (ex.: arquivo pela metade), a configuração anterior continua e a troca é tentada de novo no ciclo seguinte.
- **Durante a troca:** que leva menos de 1 s, as consultas falham como "fora do ar" (503 com `Retry-After`). Os eventos esperam no outbox.

---

## Logs

```
api-clean-architecture @ 2026-11-17T14:14:25.768Z info: [mongodb] Conexão com MongoDB estabelecida
api-clean-architecture @ 2026-11-17T14:14:26.452Z info: [rabbitmq] Conexão RabbitMQ (publish) estabelecida
api-clean-architecture @ 2026-11-17T14:14:26.445Z info: [http] ::ffff:127.0.0.1 - "POST /auth/login HTTP/1.1" 200 1404 92.515 ms "-" "curl/7.68.0" trace_id=5f2c...
```

- **Nível e formato:** `LOG_LEVEL` aceita `silent`, `error`, `warn`, `info` ou `debug`. `LOG_FORMAT` aceita `text` ou `json` (uma linha JSON por log). As cores só aparecem em terminal; `NO_COLOR` desliga e `FORCE_COLOR` liga.
- **Porta e implementação:** a aplicação depende da porta `ILogger`, e a implementação é `infrastructure/logger/console.logger.ts`, sem dependências. Trocar por pino ou winston é escrever outro adaptador.
- **Requisições:** uma linha por requisição, no formato *combined*, com o tempo de resposta. `/health*` só aparece em `debug`.
- **Erros não tratados:** saem com o stack e o `request_id`.
- **Correlação:** dentro de um trace, cada linha termina com `trace_id=...` (em JSON, campos `trace_id`/`span_id`). Com o OpenTelemetry ligado, a mesma linha também vai para o Loki, associada ao trace.

---

## Observabilidade (OpenTelemetry + Grafana LGTM)

A telemetria liga quando `OTEL_EXPORTER_OTLP_ENDPOINT` está definido (já está no `.env.docker` e no compose). É carregada antes da aplicação com `node --import ./src/main/telemetry.ts`, o que os scripts npm e o Dockerfile já fazem.

A API envia os três sinais por OTLP ao **Grafana LGTM** (`grafana/otel-lgtm`), que reúne OpenTelemetry Collector, Tempo, Prometheus, Loki e Grafana em um contêiner, para desenvolvimento. O Grafana fica em **http://localhost:3001** e entra direto como admin.

| Sinal | Onde ver | Conteúdo |
|---|---|---|
| Traces | Explore > Tempo | Kong → API → MongoDB, Redis, RabbitMQ: um trace por requisição, incluindo a publicação feita depois pelo outbox |
| Métricas | Explore > Prometheus | `http_server_request_duration_seconds`, event loop, heap, GC, `outbox_events_pending`, `outbox_oldest_pending_age_seconds`, `outbox_events_published_total`, `outbox_events_failed_total`, `jobs_completed_total`, `jobs_duration_seconds`, `passages_written_total` |
| Logs | Explore > Loki (`{service_name="api-clean-architecture"}`) | Cada linha do logger, com nível, componente, metadados e `trace_id` |

- **Dashboard pronto:** *Dashboards > API > API Clean Architecture*, provisionado de `observability/grafana/dashboards/api.json`.
  - SLO: disponibilidade e latência em 30 dias, orçamento de erros restante e *burn rate*.
  - HTTP: taxa, erros 5xx e latência p95 por rota.
  - Outbox e mensagens enviadas para a DLQ, jobs, passagens, event loop e heap.
  - Logs filtráveis por nível e texto, e traces recentes.
  - Pode ser editado na interface; para versionar, exporte o JSON por cima do arquivo.
- **Log ↔ trace:** no painel de logs, o `trace_id` vira link para o trace; num trace, *Logs for this span* abre as linhas daquele trace.
- **Também por scrape:** as métricas ficam em `:9464/metrics`, no formato Prometheus. O Prometheus avulso (`docker compose --profile metrics up -d prometheus`, em `:9090`) coleta `api:9464` e `host.docker.internal:9464`; o alvo que não estiver rodando aparece como `down`.
- **Instrumentação automática:** HTTP, Express, MongoDB, ioredis e amqplib. O contexto do trace segue nos headers das mensagens do RabbitMQ.
- **Fora dos traces:** `/health/*`, os arquivos da documentação e `/metrics`. Os spans do MongoDB não gravam os valores das consultas.
- **Kong:** o plugin `opentelemetry` envia os spans do gateway e propaga o `traceparent` (W3C).
- **Sem custo quando desligado:** sem o SDK (testes, modo rápido), a API do OpenTelemetry é um no-op.

### Alertas e SLOs

**Objetivos (30 dias):**

| SLO | Indicador | Objetivo | Orçamento |
|---|---|---|---|
| Disponibilidade | Respostas sem 5xx / todas as respostas (503 conta como erro) | 99,5% | 0,5% das requisições (~3,6 h de indisponibilidade total por mês) |
| Latência | Respostas em até 500 ms / todas | 95% | 5% podem passar de 500 ms |

**Onde os alertas estão:**

- **Local:** provisionados no Grafana do LGTM, a partir de [`observability/grafana/alerting/api.yaml`](observability/grafana/alerting/api.yaml) (*Alerting > Alert rules*, pasta API).
- **Kubernetes:** no `PrometheusRule` do chart (`metrics.prometheusRule.enabled`). As regras são as mesmas; muda só o seletor: `service_name` no OTLP e `job` no scrape.

| Alerta | Condição | Severidade |
|---|---|---|
| Orçamento de erros 14x | 5xx acima de 7,2% em 1 h **e** em 5 min (o mês de orçamento acaba em ~2 dias) | crítica |
| Orçamento de erros 6x | 5xx acima de 3% em 6 h **e** em 30 min | aviso |
| Latência | Mais de 10% acima de 500 ms em 1 h **e** em 5 min | aviso |
| Outbox parado | Evento pendente há mais de 5 min | crítica |
| Mensagens na DLQ | Alguma mensagem foi para `<APP_NAME>.dlq` em 15 min | aviso |
| Jobs falhando | Mais de 10% dos jobs falharam em 30 min | aviso |
| Event loop | Atraso p99 acima de 200 ms por 10 min | aviso |
| Sem telemetria / API fora | Nenhuma métrica da API há 5 min (local) ou nenhum alvo `up` (Kubernetes) | crítica |

**Duas janelas** (*multi-window burn rate*, do SRE Workbook do Google): a janela longa confirma que o problema é relevante, e a curta faz o alerta parar logo que o problema acaba. Assim os alertas disparam rápido em incidentes e não ficam piscando.

**Notificações:** cadastre um *contact point* no Grafana (e-mail, Slack, PagerDuty) ou configure o Alertmanager no Kubernetes. O `runbook_url` de cada alerta aponta para esta seção.

---

## Documentação da API (OpenAPI)

| URL | Conteúdo |
|---|---|
| `/reference` | Swagger UI: documentação navegável e testes ("Try it out" já vem aberto) |
| `/reference/openapi.json` | Documento OpenAPI 3.1 |
| `/reference/openapi.yaml` | O mesmo documento em YAML (Postman, Insomnia, geradores de cliente) |

**Teste rápido:**

1. Em **POST /auth/login**, clique em *Execute*: o exemplo já traz o admin local.
2. O `access_token` entra sozinho em *Authorize* e persiste se a página for recarregada.
3. Chame qualquer rota protegida.

O **POST /devices/claim** funciona igual: o token do dispositivo entra em *Authorize*, e dá para enviar passagens como se fosse a ESP32.

**Como o documento é gerado:** em código ([document.ts](src/presentation/http/openapi/document.ts)), sem anotações espalhadas, a partir de fontes que já existem:

- **Corpos de requisição:** saem dos mesmos schemas zod da validação (`z.toJSONSchema`).
- **Parâmetros de listagem:** saem do `QuerySchema` de cada recurso.
- **Quem pode chamar:** o texto ("Escopo: `jobs:read` — administrador, gestor, cliente") é calculado de `ROLE_SCOPES`.
- **Respostas:** escritas à mão em [components.ts](src/presentation/http/openapi/components.ts), porque são o contrato público.

**Sincronia garantida por teste** ([openapi.test.ts](test/http/openapi.test.ts)):

- o documento é um OpenAPI 3.1 válido;
- toda rota do Express está documentada, e toda rota documentada existe;
- as respostas reais (incluindo 400, 401, 403, 404 e 409) seguem os schemas documentados.

Para desligar (ex.: em produção), use `API_DOCS_ENABLED=false`.

---

## Testes

| Tipo | Pasta | Dependências | Comando |
|---|---|---|---|
| Unitários | `test/unit/` | nenhuma | `npm test` |
| HTTP (supertest) | `test/http/` | nenhuma (em memória) ou reais | `npm test` / `npm run test:docker` |
| Integração | `test/integration/` | MongoDB (replica set), Redis, InfluxDB, RabbitMQ | `npm run test:docker` (ignorados sem as variáveis) |
| Os mesmos, com TLS | `test/http/` e `test/integration/` | as dependências do `docker-compose.tls.yml` | `npm run test:docker:tls` |
| TLS | `test/unit/tls.test.ts` | `openssl` (ignorado sem ele) | `npm test`: validação das variáveis, HTTPS com mTLS e recarga do certificado |
| Segredos e Vault | `test/unit/secrets.test.ts`, `test/unit/mfa.test.ts` | nenhuma (Vault falso em memória) | `npm test`: `<VAR>_FILE`, recarga por conteúdo, Transit (cifra, *rewrap*, migração da chave local, 503) |
| Chart base | `test/unit/helm.test.ts` | `helm` e o chart base em `../platform-infra` ou `PLATFORM_CHART_DIR` (ignorado sem eles) | `npm test`: renderiza o chart base com `deploy/values.yaml` e valida o `env` com o `loadEnv` da API; cada arquivo esperado tem template no Agent |
| Reconexão e migração | `test/integration/reload.test.ts` | MongoDB e Redis | `npm run test:docker`: reconexão com credenciais novas e migração de índices idempotente |
| Tudo, com Vault | `test/http/` e `test/integration/` | o ambiente do `docker:infra:vault` | `npm run test:docker:vault`: credenciais temporárias, PKI e Transit reais |

- **Conexões diretas nos testes:** `test/helpers/connections.ts` entrega o TLS e as credenciais do ambiente, que podem vir de arquivo, então o mesmo teste roda nos modos sem TLS, TLS e Vault.
- **Isolamento:** `test/helpers/make.app.ts` monta o app com banco e fila próprios (`<MONGO_DB>_test` e prefixo `bull-<banco>`), sem misturar com a API de desenvolvimento, mesmo rodando ao lado.
- **Logs nos testes:** `TEST_LOG_LEVEL=info npm test`.
- **Esperas:** use `waitForJob` / `waitUntil` em vez de `sleep` fixo.

---

## Integração contínua

**Destino: GitLab** ([`.gitlab-ci.yml`](.gitlab-ci.yml)), com os componentes do repositório `ci-templates` da plataforma (uma correção lá vale para todos os serviços) e o git-flow:

| Evento | Jobs |
|---|---|
| Merge request | `node-quality` (lint, typecheck, testes), `security` (npm audit, Trivy, SAST e Secret Detection do GitLab), `helm-validate` (chart base + `deploy/values.yaml` + kubeconform), `tofu-validate` (`dev/vault`), `integration`, `integration-tls` e `integration-vault` |
| `develop` | + `container-image` (Buildah sem privilégio, Trivy, SBOM, cosign) e `promote-dev` (commit no GitOps) |
| `release/*` | + `container-image` e `promote-hml` (MR no GitOps) |
| tag `vX.Y.Z` | `promote-prd`: MR copiando digest e revisão de homologação para produção |
| agendado | `renovate` (preset `platform/ci-templates:renovate-preset`) |

- **Integração:** os jobs com Docker Compose rodam no **runner dedicado** (VM do Proxmox, tag `docker-host`), nunca como pod privilegiado no cluster.
- **Credenciais:** `GITOPS_TOKEN` (escrita no `matrixgrid-gitops`) e `RENOVATE_TOKEN`, no grupo; o acesso ao Vault é por JWT do GitLab.

**Transição (enquanto o repositório está no GitHub):** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) continua rodando a cada push em `main`/`develop` e em todo pull request:

| Job | O que faz |
|---|---|
| `quality` | `npm ci`, lint, typecheck e testes em memória |
| `integration` | Sobe MongoDB (replica set), Redis, InfluxDB e RabbitMQ e roda `npm run test:docker` |
| `image` | `npm run docker:up` (build + ambiente completo, incluindo o LGTM) e teste de fumaça pelo Kong: readiness, documentação e login |
| `tls` | Sobe as dependências com TLS e roda `npm run test:docker:tls`. Depois, `npm run docker:up:tls` e fumaça em `https://localhost:8443`, conferindo que a API recusa conexão sem certificado |
| `vault` | `npm run docker:up:vault`: aplica `dev/vault` num Vault dev e sobe tudo. Confere a readiness (com o check `vault`), o login e se a API se conectou com o usuário temporário do Mongo. Depois roda `npm run test:docker:vault` |
| `security` | `npm audit --omit=dev --audit-level=high`; Trivy no repositório (vulnerabilidades e segredos, bloqueante) e em IaC/configuração (relatório na aba *Security*); build da imagem e Trivy nela (bloqueante para altas e críticas com correção) |
| `iac` | `tofu fmt -check` e `tofu validate` de `dev/vault`; com o segredo `PLATFORM_REPO_TOKEN` (leitura de `platform-infra`), `helm lint`, `helm template` e `kubeconform` do chart base com `deploy/values.yaml` |
| CodeQL (`codeql.yml`) | SAST do TypeScript (consultas `security-extended`) em push, PR e toda segunda |

O [Dependabot](.github/dependabot.yml) abre PRs semanais (npm, actions, Docker, `docker-compose*.yml` e providers de `dev/vault`); a versão maior do InfluxDB é ignorada. Na migração para o GitLab, remova `.github/` (Actions, Dependabot e CodeQL), que o `.gitlab-ci.yml` e o Renovate substituem.

---

## Variáveis de ambiente

Sem `.env`, valem os padrões abaixo. Para customizar, copie `.env.example` para `.env`. O modo Docker usa `.env.docker`.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP (ou HTTPS) |
| `HEALTH_PORT` | `0` (desligada) | Porta só com `/health*`, em HTTP, para as probes quando a principal exige certificado de cliente (8081 no chart) |
| `<VAR>_FILE` | — | Lê o segredo de um arquivo (Vault Agent, Secret): `MONGO_URI`, `MONGO_USERNAME`, `MONGO_PASSWORD`, `REDIS_URL`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `RABBITMQ_URI`, `RABBITMQ_USERNAME`, `RABBITMQ_PASSWORD`, `INFLUX_TOKEN`, `ADMIN_PASSWORD`, `MFA_ENCRYPTION_KEY`, `MFA_ENCRYPTION_PREVIOUS_KEYS`. Não defina a variável e o `_FILE` juntos |
| `SECRETS_RELOAD_INTERVAL_MS` | `30000` | Frequência com que arquivos de segredos e certificados são relidos (0 desliga a recarga) |
| `SERVER_TLS` e `SERVER_TLS_*` | `false` | HTTPS e mTLS no servidor da API; ver [TLS](#variáveis) |
| `<P>_TLS` e `<P>_TLS_*` (`MONGO_`, `REDIS_`, `RABBITMQ_`, `INFLUX_`) | `false` | TLS de cada conexão de saída; ver [TLS](#variáveis) |
| `TLS_CA_FILE` / `TLS_CLIENT_CERT_FILE` / `TLS_CLIENT_KEY_FILE` | — | Padrões de CA e identidade (mTLS) de todas as conexões de saída |
| `APP_NAME` | `api-clean-architecture` | Nome do serviço: logs, `service` da auditoria, fila `<APP_NAME>` e exchange RPC `<APP_NAME>.rpc` |
| `REPOSITORY_DRIVER` | `memory` | `memory` ou `mongo` |
| `MONGO_URI` / `MONGO_DB` | — / `app` | Com `mongo`; com o compose, a URI precisa de `?directConnection=true` |
| `MONGO_USERNAME` / `MONGO_PASSWORD` / `MONGO_AUTH_SOURCE` | — / — / `admin` | Credenciais fora da URI (no modo Vault, temporárias e em arquivo) |
| `MONGO_AUTO_INDEX` | `true` | Cria os índices na inicialização; `false` quando vêm do `npm run db:migrate` (Kubernetes e modo Vault) |
| `QUEUE_DRIVER` | `in-process` | `in-process` ou `redis` (exige `mongo`) |
| `REDIS_URL` / `QUEUE_PREFIX` | — / `bull` | Com `redis`; o prefixo separa ambientes no mesmo Redis |
| `REDIS_USERNAME` / `REDIS_PASSWORD` | — | Substituem os da URL |
| `TIMESERIES_DRIVER` | `memory` | `memory` ou `influx` |
| `INFLUX_URL` / `INFLUX_TOKEN` / `INFLUX_ORG` / `INFLUX_BUCKET` | — | Obrigatórias com `influx` |
| `EVENT_BUS_DRIVER` | `memory` | `memory` ou `rabbitmq` |
| `RABBITMQ_URI` | — | Com `rabbitmq`, ex.: `amqp://app:app-rabbit-local@127.0.0.1:5672` |
| `RABBITMQ_RETRY_INTERVAL_MS` / `RABBITMQ_RPC_TIMEOUT_MS` | `2000` / `5000` | Intervalo inicial de reconexão / tempo máximo de uma chamada RPC |
| `RABBITMQ_USERNAME` / `RABBITMQ_PASSWORD` | — | Substituem os da URI (no modo Vault, temporários e em arquivo) |
| `RABBITMQ_SUBSCRIBER_ATTEMPTS` | `3` | Tentativas de um subscriber antes de a mensagem ir para `<APP_NAME>.dlq` (1 a 10) |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Com que frequência o relay procura eventos gravados por outras instâncias |
| `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` | — | Par RSA (PEM), definidos juntos. Sem eles, chaves temporárias: os tokens morrem ao reiniciar e o Kong não os aceita |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `api-clean-architecture` | Claims `iss`/`aud`; o `iss` precisa bater com o consumer do Kong |
| `JWT_EXPIRES_IN_SECONDS` | `900` | Validade do access token (60 a 86400) |
| `REFRESH_TOKEN_TTL_SECONDS` | `604800` | Validade absoluta da sessão (1h a 90 dias) |
| `PAIRING_CODE_TTL_SECONDS` | `600` | Validade do código de pareamento (60 a 3600) |
| `DEVICE_TOKEN_TTL_SECONDS` | `31536000` | Validade do token do dispositivo (1 a 365 dias) |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `Administrador` / — / — | Admin criado na inicialização, se não existir; e-mail e senha juntos (senha com ≥ 8 caracteres) |
| `MFA_CIPHER` | `local` | `local` (AES com `MFA_ENCRYPTION_KEY`) ou `vault-transit` (a chave fica no Vault) |
| `VAULT_ADDR` / `VAULT_TOKEN_FILE` / `VAULT_NAMESPACE` | — | Vault ou Vault Agent (no pod, `http://127.0.0.1:8200`, que já injeta o token); token em arquivo, se não for pelo Agent. TLS com `VAULT_TLS_*` |
| `VAULT_TRANSIT_MOUNT` / `VAULT_TRANSIT_KEY` | `transit` / `mfa` | Chave do Transit usada pelo MFA |
| `MFA_ENCRYPTION_KEY` | — | Chave AES-256 (base64, `openssl rand -base64 32`) que cifra os segredos TOTP. **Obrigatória com `mongo`**; em memória, sem ela, a API usa uma chave temporária |
| `MFA_ENCRYPTION_PREVIOUS_KEYS` | — | Chaves anteriores, separadas por vírgula, durante a rotação |
| `MFA_REQUIRED_ROLES` | — | Papéis que só recebem escopos com MFA (ex.: `admin` ou `admin,manager`). Vazio: opcional para todos |
| `MFA_ISSUER` | `APP_NAME` | Nome que aparece no aplicativo autenticador |
| `MFA_CHALLENGE_TTL_SECONDS` | `300` | Tempo para digitar o código depois da senha (60 a 900) |
| `REPORT_DURATION_MS` | `3000` | Duração simulada do relatório |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `text` | Ver [Logs](#logs) |
| `AUDIT_ENABLED` / `AUDIT_IGNORE_PATHS` / `AUDIT_MAX_BODY_BYTES` | `true` / `/health,/.well-known,/reference` / `16384` | Auditoria por requisição |
| `API_DOCS_ENABLED` | `true` | Swagger UI e documento em `/reference` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | Liga o OpenTelemetry (ex.: `http://127.0.0.1:4318`) |
| `OTEL_SERVICE_NAME` | `APP_NAME` | Nome do serviço nos sinais |
| `OTEL_METRICS_PORT` / `OTEL_METRICS_HOST` | `9464` / `0.0.0.0` | Porta e interface do `/metrics` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | Intervalo de envio das métricas por OTLP (ms) |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` / `OTEL_SDK_DISABLED` | — | Variáveis padrão do OpenTelemetry |
| `KONG_UPSTREAM_URL` | `http://api:3000` | Só para `kong:setup`: onde o Kong encontra a API |
| `KONG_UPSTREAM_CA_FILE` / `KONG_UPSTREAM_CLIENT_CERT_FILE` / `KONG_UPSTREAM_CLIENT_KEY_FILE` | `./certs/ca.crt` / `./certs/kong.crt` / `./certs/kong.key` | Só para `kong:setup` com upstream `https://`: CA que verifica a API e certificado do Kong (mTLS) |
| `KONG_RATE_LIMIT_REDIS_HOST` / `_PORT` / `_PASSWORD` / `_DATABASE` | — / `6379` / — / `1` | Só para `kong:setup`: rate limit contado no Redis (`policy: redis`); sem o host, `local` |
| `KONG_OTEL_TRACES_ENDPOINT` | `http://lgtm:4318/v1/traces` | Só para `kong:setup`: para onde o Kong envia os traces |
| `LOKI_EXTRA_ARGS` | — | Só no compose: argumentos extras do Loki (ver [Problemas comuns](#problemas-comuns)) |

`.env.docker`, `.env.tls` e `.env.vault` estão versionados de propósito: contêm apenas valores locais, inclusive a senha do admin de desenvolvimento. As chaves ficam em `keys/` e os certificados em `certs/`, fora do git. Com mais de um `--env-file`, o Node dá prioridade ao último: o `.env.tls` sobrescreve o `.env.docker`.

---

## Scripts npm

| Script | O que faz |
|---|---|
| `npm run dev` / `npm start` | API com / sem `--watch` (lê `.env` se existir) |
| `npm run dev:docker` / `start:docker` | O mesmo, com `.env.docker` |
| `npm run docker:up` | Gera chaves e `kong.yml`, faz o build da imagem e sobe tudo |
| `npm run docker:infra` | Sobe só as dependências e o Kong (apontando para a API no host) |
| `npm run docker:up:tls` / `docker:infra:tls` | Os mesmos, com TLS em tudo (gera certificados e `kong.yml` com upstream `https`) |
| `npm run dev:docker:tls` / `start:docker:tls` | API no host com `.env.docker` + `.env.tls` |
| `npm run docker:up:vault` / `docker:infra:vault` | Modo Vault: recria o Vault dev, aplica `dev/vault` com OpenTofu, sobe tudo (ou as dependências) com segredos do Vault |
| `npm run dev:docker:vault` / `start:docker:vault` | API no host com `.env.docker` + `.env.tls` + `.env.vault` |
| `npm run vault:bootstrap` | Só aplica `dev/vault` no Vault local que já está de pé |
| `npm run vault:sync-modules` | Copia os módulos do Vault de `../platform-infra` (ou `PLATFORM_INFRA_DIR`) para `dev/vault/modules` |
| `npm run db:migrate` / `db:migrate:docker` | Cria os índices que faltam no MongoDB (`-- --drop` também remove os obsoletos) |
| `npm run docker:build` / `docker:logs` / `docker:down` | Build da imagem / logs da API / para os containers (inclusive os do modo Vault) |
| `npm test` | Testes (os de integração são ignorados sem as variáveis) |
| `npm run test:docker` | Testes contra as dependências do compose |
| `npm run test:docker:tls` | Testes contra as dependências com TLS |
| `npm run test:docker:vault` | Testes contra as dependências do modo Vault (credenciais em `.vault/secrets`) |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7) |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run kong:setup` | Gera as chaves JWT (se faltarem) e `kong/kong.yml` |
| `npm run tls:setup` | Gera a CA local e os certificados em `certs/` (`-- --force` regenera) |

---

## Pontos de atenção

### Segurança

1. **Toda rota nova precisa passar pelo Kong.** Se o prefixo não estiver em nenhuma rota de `kong/kong.template.yml`, o gateway responde 404. Ao incluir em `protected`, a rota herda `jwt` + rate limit. Não crie rotas públicas no Kong sem rate limit.
2. **Autorização é responsabilidade da API, não do Kong.** O Kong só confere assinatura e expiração. Toda rota protegida deve usar `guard(...)`, e toda regra de "dono do recurso" deve estar no service. Esquecer o `guard` deixa a rota aberta a qualquer token válido.
3. **Recurso alheio responde 404, não 403**, para não revelar quais ids existem. Mantenha esse padrão.
4. **A restrição de acesso entra com `and()`** nas listagens. Nunca deixe a query string sobrescrever o filtro de acesso, como acontece em `listClients`.
5. **Toda query string passa pela whitelist** (`*.query.schema.ts`). Nunca exponha campos sensíveis (hash de senha, segredos) no `QuerySchema`, nem passe `req.query` direto ao repositório.
6. **O que sai na resposta é o `toJSON()` do model.** Campos sensíveis devem ser omitidos ali (como `passwordHash` em `User`), e o teste de contrato do OpenAPI acusa campos novos não documentados.
7. **O RPC no RabbitMQ não tem autenticação de aplicação.** Quem alcança o broker com permissão no vhost lê usuários e jobs. Mantenha o RabbitMQ só na rede interna, com mTLS e usuários por serviço (no modo Vault, temporários e restritos ao vhost), e nunca use `app`/`app-rabbit-local` fora do ambiente local.
8. **Chaves e segredos:** `keys/`, `certs/`, `.vault/` e `.env` nunca vão para o git. Em produção, os segredos vêm do Vault (módulos de `platform-infra`), nunca de variáveis no manifesto. Trocar as chaves dos JWTs muda o `kid`: atualize `kong.jwt.publicKey` e faça o rollout. Sem `JWT_*_KEY_PATH`, a API gera chaves temporárias: aceitável só em desenvolvimento.
9. **Segredos na auditoria:** um campo sensível novo (ex.: `apiKey`) deve entrar na lista do `redact.ts`, senão vai para a exchange `audit` em texto puro.
10. **Clientes web:** guarde o refresh token em cookie `HttpOnly`/`Secure`/`SameSite=Strict`, nunca em `localStorage`. Serialize a renovação: dois refreshes com o mesmo token revogam a sessão.
11. **Portas locais sem autenticação:** nos modos 2 a 6, Mongo e Redis do compose não têm senha e só escutam em `127.0.0.1`. O modo Vault liga a autenticação (usuários temporários no Mongo, senha no Redis); em produção, use sempre autenticação e rede privada. O mTLS autentica a conexão, mas não substitui usuário e senha. A Admin API do Kong (`:8001`) nunca pode ser exposta.
12. **InfluxDB:** o `INFLUX_TOKEN` local é de administração. Em produção, use um token restrito ao bucket `sensors`.
13. **TLS é desligado por padrão.** Em produção, ligue em todos os trechos (modo 6 como referência) e nunca use `*_TLS_REJECT_UNAUTHORIZED=false`: isso aceita qualquer certificado e anula a proteção contra interceptação.
14. **Certificados de `tls:setup` são só para desenvolvimento.** As chaves dos serviços ficam com permissão 0644 (cada container roda com um uid diferente), a CA é local e o `kong.yml` gerado contém a chave do Kong. Nada disso vai para o git, nem deve ir para produção.
15. **OTLP e `/metrics` continuam em HTTP.** O receptor do `otel-lgtm` não tem TLS, e o exportador Prometheus (porta 9464) também não. Em produção, mande o OTLP para um Collector com TLS (`https://` e `OTEL_EXPORTER_OTLP_CERTIFICATE`) e mantenha o `/metrics` só na rede interna.
16. **Validade dos certificados:** a API recarrega sozinha o certificado do servidor e os de cliente quando os arquivos mudam (`SECRETS_RELOAD_INTERVAL_MS`), e o `SIGHUP` força a troca do certificado do servidor. Quem renova é o Vault Agent (`pkiCert`, 72 h) ou o cert-manager. Monitore a renovação: um certificado vencido derruba as conexões no handshake e aparece como dependência fora do ar (503).
17. **Ligue o MFA obrigatório para o administrador em produção** (`MFA_REQUIRED_ROLES=admin`). No `.env.docker` ele fica vazio para os testes e a demonstração continuarem simples.
18. **Cifra do MFA:** com `MFA_CIPHER=local`, a `MFA_ENCRYPTION_KEY` é um segredo de produção como a chave dos JWTs (perdida sem rotação, todos os usuários com MFA precisam de reset). Prefira `MFA_CIPHER=vault-transit`: a chave fica no Vault, que rotaciona sozinho. Nesse caso, o Vault fora do ar impede o login com MFA (503).
19. **Relógio do servidor:** o TOTP depende da hora. Mantenha o NTP ativo nos hosts e containers; mais de 30 s de diferença recusa códigos válidos.
20. **Rota sensível nova pode exigir MFA na sessão**, conferindo `actor.amr?.includes('mfa')` no service (ex.: alterar e-mail ou senha, gerar chaves). O `amr` também vai no JWT para outros serviços decidirem o mesmo.
21. **O Vault vira dependência de inicialização.** Sem ele, pods novos não recebem segredos e não sobem; os que estão de pé continuam, porque o Agent guarda o que já buscou, até as credenciais vencerem (24 h no máximo). Em produção, use o Vault em HA (Raft, 3 ou 5 nós), com *auto-unseal* no KMS e backup dos snapshots, ou um serviço gerenciado.
22. **O Vault local é descartável (modo dev).** Tudo fica em memória e é recriado a cada `docker:up:vault`, inclusive a CA: os certificados em `certs/` mudam a cada subida. O token `dev-root-token` e as senhas de `envs/local.tfvars` são só locais.
23. **Estado do OpenTofu tem segredos.** Use estado remoto, com acesso restrito e cifrado (`TF_ENCRYPTION`). Senhas de administração vêm de `TF_VAR_*` no pipeline, e os segredos estáticos de produção vão direto para o Vault (`vault kv put`), nunca em `tfvars`.
24. **Política mínima:** a política `api-clean-architecture` só lê os próprios caminhos. Segredo novo exige mudar `vault.files` no `deploy/values.yaml` e a política no módulo; sem a política, o Agent recebe 403 e o pod não sobe.

### Consistência e dados

25. **Eventos só pelo outbox, dentro da transação.** Nunca chame `eventBus.publish` direto em um service: se a gravação falhar depois da publicação (ou o contrário), os serviços ficam inconsistentes. Use `unitOfWork.run(() => { repo.save(...); outbox.add(...) })`.
26. **O MongoDB precisa ser replica set** para as transações. Com um `mongod` avulso, a API sobe, mas avisa que dado e evento não são atômicos. A URI do compose precisa de `?directConnection=true`.
27. **Entrega "pelo menos uma vez":** eventos podem chegar duplicados, e os consumidores devem ser idempotentes (pelo `messageId` / `audit.id`). O mesmo vale para os subscribers deste serviço.
28. **Mensagens com falha vão para `<APP_NAME>.dlq`** depois de `RABBITMQ_SUBSCRIBER_ATTEMPTS` tentativas, com o motivo nos headers. Acompanhe o alerta da DLQ e reprocesse depois de corrigir a causa. A fila não tem limite de tamanho: não deixe acumular.
29. **Handlers de job devem ser idempotentes:** o BullMQ pode reexecutar após falha (3 tentativas com backoff).
30. **`recoverStale` só vale para o modo em processo com instância única.** Com várias instâncias, use `QUEUE_DRIVER=redis`.
31. **Índices do Mongo:** em produção são criados pelo job de migração (`npm run db:migrate`, hook do Helm) e a API sobe com `MONGO_AUTO_INDEX=false`. Índice novo em coleção grande pode demorar: o job tem `activeDeadlineSeconds` (10 min). Remover índices obsoletos (`--drop`) é opcional e explícito. Nos modos locais (exceto o 7), a API ainda cria os índices na inicialização.
32. **Volume do outbox:** cada requisição auditada grava um documento. Com muito tráfego, acompanhe `outbox_events` (os enviados expiram em 7 dias) ou dê à auditoria um caminho próprio.
33. **InfluxDB 2.x em fim de ciclo:** a 2.x só recebe correções de segurança e de defeitos críticos, e o Flux (usado pela API) está em modo de manutenção. O InfluxDB 3 não executa Flux, e o 3 Core limita cada consulta a ~72 h de dados, porque não compacta. Por isso a imagem é fixada em `influxdb:2.7.12` e o Dependabot ignora a versão maior. Caminho de saída: reescrever as consultas em InfluxQL (aceito na 2.x e na 3) e depois escolher entre InfluxDB 3 Enterprise/Cloud ou outro banco de séries temporais; só muda o adaptador de `IPassageStore`.
34. **InfluxDB:** um campo novo com alta variação (ids, textos) deve ser *field*, nunca *tag*, para não explodir a cardinalidade.

### Operação

35. **Readiness ≠ liveness:** use `/health/ready` para o balanceador e `/health/live` para reiniciar. Usar `ready` como liveness reinicia containers saudáveis sempre que o banco oscila.
36. **Dependência nova = health check + classificação de indisponibilidade.** Sem isso, a falha vira 500 em vez de 503 e não aparece no `/health/ready`.
37. **Rate limit do Kong:** com `policy: redis` (padrão no chart e nos modos `docker:up`/`docker:infra`), o limite vale para todas as réplicas do Kong. Nos modos TLS e Vault, fica `local`: o Redis exige certificado de cliente e o plugin do Kong não apresenta um. Se o Redis cair, o Kong deixa passar (`fault_tolerant`) em vez de bloquear.
38. **Checagem de sessão por requisição:** é uma consulta ao banco por requisição. Com muito tráfego, um cache curto em Redis resolve, aceitando alguns segundos de atraso na revogação.
39. **Amostragem de traces:** em produção, configure `OTEL_TRACES_SAMPLER=parentbased_traceidratio` e `OTEL_TRACES_SAMPLER_ARG=0.1`, e aponte o OTLP para um Collector. O LGTM é só para desenvolvimento.
40. **Loki e disco cheio:** o Loki recusa gravações com o disco acima de 90%. O ajuste `LOKI_EXTRA_ARGS` é só para desenvolvimento.
41. **Fuso dos agendamentos:** `America/Recife`, fixo no código. Ajuste se o servidor e as regras de negócio forem de outro fuso. Datas sem fuso na query string usam o fuso do servidor.
42. **Porta 3001 é do Grafana:** a segunda instância local da API deve usar outra porta (ex.: 3002).
43. **Permissão das chaves no container:** a chave privada (0600) precisa pertencer ao uid 1000 (usuário `node` da imagem). O Vault Agent roda com o mesmo uid (`agent-run-as-user: 1000` no chart; `user: 1000:1000` no compose). No modo Vault local, os arquivos de `.vault/secrets` ficam com permissão 0644, para a API no host ou os testes no CI (outro uid) lerem; no Kubernetes, 0600.
44. **Troca de credenciais é um blip curto:** quando o Agent entrega credenciais novas (fim do TTL máximo, 24 h) ou um certificado renovado, a conexão afetada é refeita. Por menos de 1 s, as requisições que precisam dela recebem 503 com `Retry-After`, e os eventos esperam no outbox. Com várias réplicas, as trocas acontecem em momentos diferentes.
45. **Kong Ingress Controller ≥ 3.4** para a anotação `konghq.com/ca-certificates-secrets`, que faz o Kong verificar o certificado da API. Em versões anteriores, ajuste `service.annotations`.
46. **Varreduras de segurança no CI bloqueiam:** vulnerabilidades altas ou críticas com correção (npm audit, Trivy no código e na imagem) quebram o build. Exceção aceita vai para `.trivyignore`, com motivo e data de revisão.

### Desenvolvimento

47. **Respeite a regra de dependência:** `domain` e `application` não importam Express, Mongoose, BullMQ, amqplib nem InfluxDB. Se precisar de algo externo, crie uma porta em `application/port` e implemente em `infrastructure`.
48. **Toda implementação real precisa da versão em memória**, para os testes e o modo rápido continuarem funcionando.
49. **Toda rota precisa estar no OpenAPI**: o teste `openapi.test.ts` falha se faltar, e também se a resposta real divergir do documento.
50. **Ordem das rotas no Express:** caminhos fixos antes dos parametrizados (`/users/me` antes de `/users/:id`, `/passages/summary` antes de `/passages`).
51. **`.ts` nas importações e sem recursos que exigem transpilação:** o Node executa TypeScript por *type stripping*, sem `enum`, `namespace` ou parameter properties. O `tsconfig` e o lint acusam.
52. **Variável de ambiente nova:** declare no schema de `di/env.ts` (com padrão e limites), em `.env.example`, em `.env.docker` (se for o caso), em `config` do chart Helm (se não for secreta) e na tabela deste README. Se for secreta, inclua em `SECRET_VARS` (para aceitar `<VAR>_FILE`) e entregue pelo Vault.

---

## Guia para novas implementações

### Passo a passo de um recurso completo

Exemplo hipotético (**não implementado**): **locais de instalação** (`Location`). O cliente cadastra os locais onde instala os dispositivos (nome, endereço), lista e consulta os próprios locais; o admin vê os de todos; outros serviços são avisados quando um local é criado. A ordem vai de dentro para fora: primeiro o que não depende de nada, por último o que expõe.

#### 1. Domínio (`src/domain/`)

1. **Model** `domain/model/location.ts`: `class Location extends Entity` com os campos (`clientId`, `name`, `address`), uma fábrica `static create(...)`, métodos de comportamento que chamam `touch()` (ex.: `rename`) e `toJSON()` se algo não puder sair na resposta.
2. **Validador** `domain/validator/location.validator.ts`: schema zod da entrada e `validateCreateLocation(input)`, lançando `ValidationError` com `issues`.
3. **Escopos** em `domain/auth/scopes.ts`: `locations:read`, `locations:read:any`, `locations:manage`, `locations:manage:any`. Conceda-os aos papéis em `ROLE_SCOPES` (client: base; admin: base + `:any`).

> Nada aqui conhece banco, HTTP ou variáveis de ambiente.

#### 2. Aplicação (`src/application/`)

4. **Porta do repositório** `port/location.repository.ts`: `ILocationRepository { findById, list(query), save, delete... }`, só com o que os casos de uso precisam.
5. **Schema de listagem** `query/location.query.schema.ts`: campos filtráveis/ordenáveis, `defaultSort`, `dateField` e limites. Só campos públicos.
6. **Evento de integração**, se outros serviços precisarem saber: `IntegrationEvents.locationCreated` em `event/integration.events.ts` (exchange `locations`, routing key `locations.created`).
7. **Service** `service/location.service.ts`, recebendo as portas pelo construtor (`repo`, `outbox`, `unitOfWork`):
   - `create(actor, input)`: valida, aplica a regra de dono (cliente cria para si; com `:any`, para qualquer um) e grava dado + evento em `unitOfWork.run(...)`.
   - `getById(actor, id)`: recurso alheio sem `:any` → `NotFoundError` (404).
   - `list(actor, query)`: combina a restrição de acesso com `and({ clientId: actor.userId }, query.filter)`.

#### 3. Infraestrutura (`src/infrastructure/`)

8. **Schema Mongoose** `database/schema/location.schema.ts`, com índices para os filtros e ordenações declarados no passo 5. Exporte em `schema/index.ts` e registre o model em `mongo.database.ts`.
9. **Mapper** `mapper/location.mapper.ts`, estendendo `BaseMapper` (model ↔ documento, `id` ↔ `_id`).
10. **Repositório Mongo** `repository/mongo/mongo.location.repository.ts`, estendendo `BaseMongoRepository` (use `findPage` para listagens; traduza erros de chave única em `ConflictError`).
11. **Repositório em memória** `repository/in-memory/in.memory.location.repository.ts`, com o mesmo contrato (use `in.memory.query.ts` para aplicar `ListQuery`).

#### 4. Composição (`src/di/`)

12. Em `di/repositories.ts`, adicione `locationRepository` nas duas ramificações (Mongo e memória). Em `di/container.ts`, instancie `LocationService` e exponha-o no `Container`.

#### 5. Apresentação (`src/presentation/http/`)

13. **Controller** `location.controller.ts`: só lê `req`, chama o service com `getActor(res)` e responde (`201` na criação, `parseListQuery` + `sendPage` nas listagens).
14. **Rotas** `location.routes.ts`, com `guard(SCOPES.x)` em cada rota e caminhos fixos antes dos parametrizados. Registre em `main/app.ts`, antes do `errorHandler`.
15. **OpenAPI:** adicione as operações em `openapi/document.ts` (corpo a partir do schema zod do passo 2, parâmetros a partir do `QuerySchema`, acesso a partir do escopo) e as respostas em `components.ts`.

#### 6. Gateway e configuração

16. **Kong:** inclua `/locations` em `paths` da rota `protected` de `kong/kong.template.yml`. Se a rota for pública, crie uma rota própria com rate limit. Depois rode `npm run kong:setup && docker compose up -d --force-recreate kong`.
17. **Auditoria:** já é automática. Se houver campo sensível novo, inclua-o em `audit/redact.ts`.
18. **Variáveis de ambiente**, se houver: `di/env.ts`, `.env.example`, `.env.docker` e a tabela do README.

#### 7. Testes (`test/`)

19. **Unitários** (`test/unit/location.service.test.ts`): regras do service com repositório em memória, `InMemoryOutbox` e `noTransaction`. Cubra dono vs `:any`, 404 para recurso alheio, validação e evento gravado.
20. **HTTP** (`test/http/locations.test.ts`): rotas com supertest via `makeApp`. Cubra 401 sem token, 403 sem escopo, 404 alheio, 400 de validação e query string.
21. **Contrato:** inclua as novas rotas em `test/http/openapi.test.ts` ("as respostas reais seguem o documento").
22. **Integração**, se houver comportamento específico do Mongo (índice único, transação): `test/integration/`.

#### 8. Fechamento

23. Atualize este README (rotas, escopos, eventos) e o `requests.http`.
24. Rode `npm run lint && npm run typecheck && npm test`, e `npm run test:docker` com o compose de pé.

**Checklist do PR:** escopo criado e concedido · `guard` em todas as rotas · regra de dono no service · versão em memória · OpenAPI + teste de contrato · Kong · evento via outbox em transação · health/503 (se houver dependência nova) · README.

### Outras extensões comuns

| Quero... | Ordem de implementação |
|---|---|
| **Novo tipo de job assíncrono** | 1) Schema do payload em `domain/validator/job.validator.ts` (`jobPayloadSchemas['tipo.acao']`) → 2) service que faz o trabalho em `application/service/` (idempotente) → 3) handler em `background/jobs/handlers.ts` → 4) rota que chama `jobService.submit` respondendo 202 (com escopo, OpenAPI e Kong) → 5) testes com `waitForJob` |
| **Nova task de background** | 1) Arquivo em `background/tasks/` retornando `{ name, runOnStartup?, schedule?, run(signal) }`, chamando um service (respeite o `signal`) → 2) registrar em `background/tasks/index.ts` → 3) teste unitário do service |
| **Publicar um evento novo** | 1) Fábrica em `application/event/integration.events.ts` → 2) no service, `outbox.add(...)` dentro do mesmo `unitOfWork.run` da gravação → 3) documentar a tabela de eventos → 4) teste conferindo o evento no `InMemoryOutbox` |
| **Consumir evento de outro serviço** | 1) Caso de uso no service (idempotente pelo `messageId` ou id do recurso) → 2) `{ eventName, exchange, routingKey, handle }` em `presentation/eventbus/subscribers.ts`, chamando o service → 3) teste de integração em `test/integration/rabbitmq.test.ts` |
| **Oferecer um recurso RPC** | 1) Método no service (reutilize o `QuerySchema` se for consulta) → 2) `{ name: 'recurso.acao', handle }` em `presentation/eventbus/rpc.resources.ts` → 3) teste de integração. Lembre que o RPC não tem autenticação: só exponha o que qualquer serviço interno pode ler |
| **Nova dependência externa** (ex.: S3, e-mail, outra API) | 1) Porta em `application/port/` → 2) adaptador real e em memória em `infrastructure/` → 3) variável `*_DRIVER` + configuração em `di/env.ts` (com `tlsClientShape` e credenciais em `SECRET_VARS`) e um `di/<area>.ts` → 4) `HealthCheck` (crítica ou não) no container → 5) reconhecer os erros de indisponibilidade em `resilience/unavailable.ts` (→ 503) → 6) conexão com retry/log de queda e retorno, `Reloadable` e fechamento em `container.close` → 7) serviço no `docker-compose.yml` (e nas camadas TLS e Vault), `.env.docker` e job `integration` do CI → 8) credenciais no Vault (módulo + template do Agent) e `config` do chart → 9) testes de integração |
| **Novo segredo** (ex.: chave de uma API externa) | 1) Nome em `SECRET_VARS` (`di/env.ts`), para aceitar `<VAR>_FILE` → 2) leitura com `currentSecret(env, ...)` no `di/`, se puder mudar sem reiniciar → 3) entrada em `vault.files` (caminho e template) e a variável `<VAR>_FILE` em `env`, no `deploy/values.yaml` → 4) se for estático: nome documentado em `platform-infra/vault/projects/matrixgrid.yaml` e valor local em `static_secrets` (`dev/vault/main.tf`); se for de outro motor, o módulo `service` da plataforma (MR na plataforma) → 5) tabela de variáveis |
| **Conexão que precisa trocar credenciais sem reiniciar** | 1) Método `reconfigure`/`reconnect` no adaptador (lê os arquivos antes de fechar: se falhar, a conexão atual continua) → 2) `Reloadable` com `watchedFiles(...)` no `di/<area>.ts` → 3) registro no `secretWatcher` do container → 4) teste de integração da reconexão |
| **Novo alerta** | Regra em `observability/grafana/alerting/api.yaml` (seletor `service_name`) e a mesma em `metrics.prometheusRule.extraRules` do `deploy/values.yaml` → painel no dashboard → linha na tabela de [Alertas e SLOs](#alertas-e-slos) |
| **Nova métrica de negócio** | Instrumento em `infrastructure/telemetry/metrics.ts`, registrado no adaptador (não no domínio) → painel em `observability/grafana/dashboards/api.json` |
| **Novo papel** | 1) Valor em `USER_ROLES` (`domain/model/user.ts`) → 2) entrada em `ROLE_SCOPES` → 3) revisar as regras de dono nos services → 4) validador de criação de usuário → 5) OpenAPI e testes |

---

## Problemas comuns

- **`.env not found. Continuing without it.`:** aviso normal do Node; valem os padrões.
- **`EADDRINUSE`:** a porta está ocupada; use `PORT=3002 npm run dev`. Em `:9464` com duas instâncias no host, dê a cada uma um `OTEL_METRICS_PORT`.
- **`ERR_UNKNOWN_FILE_EXTENSION` / erro de sintaxe ao importar `.ts`:** Node antigo; use ≥ 22.18.
- **`ECONNREFUSED` em 27017/6379/8086/5672:** as dependências não estão de pé; rode `npm run docker:infra` ou `docker:up` e confira com `docker compose ps`.
- **`QUEUE_DRIVER=redis exige REPOSITORY_DRIVER=mongo`:** combinação recusada de propósito.
- **Kong responde 401 para um token emitido pela API:** a API está com chaves temporárias ou diferentes das do Kong. Confira `JWT_*_KEY_PATH` e rode `npm run kong:setup && docker compose restart kong`.
- **Kong responde 404 `no Route matched`:** o prefixo da rota não está no `kong.template.yml`.
- **Kong responde 502:**
  - Com `docker:up`, veja `npm run docker:logs`.
  - Com `docker:infra`, a API não está na porta 3000 do host, ou um firewall (ex.: `ufw`) bloqueia a rede do Docker.
- **`EACCES` em `keys/jwt.private.pem` no container:** o seu uid não é 1000. Suba com `HOST_UID=$(id -u) HOST_GID=$(id -g) npm run docker:up` (o container da API roda com esse uid).
- **`kong/kong.yml` virou uma pasta:** o compose subiu sem `kong:setup`. Apague a pasta e use `npm run docker:up`.
- **`429` no login:** limite de 10 por minuto do Kong; aguarde.
- **Refresh responde 401 logo após funcionar:** o mesmo refresh token foi usado duas vezes e a sessão foi revogada por reuso. Faça login de novo.
- **ESP32:**
  - **401 no claim:** o código está errado, expirou ou já foi usado.
  - **400 "Data no futuro" ou "mais de 30 dias":** o relógio não foi sincronizado; configure NTP (`configTime`).
  - **403 no envio:** o `clientId` ou o `deviceId` não corresponde ao token.
  - **401 no envio:** o dispositivo foi revogado ou pareado de novo.
- **`ACCESS_REFUSED` no RabbitMQ:** credenciais erradas; use `app` / `app-rabbit-local` (o `guest` só funciona de dentro do container).
- **RabbitMQ não sobe com `.erlang.cookie: eacces`:** o volume tem um cookie criado como root (versões antigas do healthcheck). Rode `docker compose down` e `docker volume rm api-clean-architecture_rabbitmq-data`, e suba de novo.
- **"Barramento indisponível: eventos ficam no outbox" na inicialização:** normal se o relay rodar antes de a conexão abrir. Os eventos saem em seguida.
- **"MongoDB sem replica set" no log:** o Mongo subiu sem `--replSet`. Recrie com `docker compose up -d mongo` e use `?directConnection=true`.
- **`/health/ready` responde 503:** o corpo mostra qual dependência crítica está `down`.
- **Nada chega ao Grafana:** confirme `OTEL_EXPORTER_OTLP_ENDPOINT` e o `--import ./src/main/telemetry.ts`; o log mostra `[telemetry] traces, métricas e logs para ...`. No Tempo, ajuste o intervalo de busca: traces novos levam alguns segundos para aparecer.
- **Taxas zeradas no dashboard logo após subir:** o Prometheus calcula taxa a partir da segunda coleta. Com tráfego contínuo, os valores aparecem.
- **Traces e métricas chegam, logs não:** o disco está acima de 90% (`Ingester is shutting down`). Libere espaço ou, só em desenvolvimento, use `LOKI_EXTRA_ARGS=-ingester.wal-disk-full-threshold=0 docker compose up -d lgtm`.
- **`400` em uma listagem:** `issues` mostra o campo, operador ou valor recusado.
- **`REPOSITORY_DRIVER=mongo exige MFA_ENCRYPTION_KEY ... ou MFA_CIPHER=vault-transit`:** gere uma chave com `openssl rand -base64 32` e coloque no `.env` (o `.env.docker` já tem uma local), ou use o Transit do Vault.
- **`Segredo no formato local: defina MFA_ENCRYPTION_KEY durante a migração`:** passou para `vault-transit` sem a chave antiga; mantenha-a até todos os usuários terem entrado de novo.
- **Código do aplicativo recusado no MFA:** confira a hora do celular (ajuste automático) e do servidor. Um código só vale uma vez: logo depois de ativar ou de outro login, espere o próximo código (até 30 s).
- **`Segredo cifrado com uma chave desconhecida`:** a `MFA_ENCRYPTION_KEY` mudou sem a anterior em `MFA_ENCRYPTION_PREVIOUS_KEYS`. Volte a chave ou redefina o MFA do usuário (`DELETE /users/:id/mfa`).
- **403 "Seu perfil exige autenticação multifator":** o papel está em `MFA_REQUIRED_ROLES`. Ative em `POST /auth/mfa/setup` e `POST /auth/mfa/enable` e renove o token em `POST /auth/refresh`.
- **401 "Etapa de MFA inválida, expirada ou sem tentativas restantes":** o `mfa_token` venceu (5 min), já foi usado ou esgotou as 5 tentativas. Faça login de novo.
- **`[vault] OpenTofu (tofu) não encontrado`:** instale o OpenTofu (https://opentofu.org/docs/intro/install/).
- **`docker:up:vault` para no `tofu apply`:** o Vault não respondeu ou o estado é de outro Vault. Rode de novo: o script recria o Vault e descarta o estado (`.vault/local.tfstate`).
- **Agent sem arquivos em `.vault/secrets` (`vault-agent` não fica saudável):** veja `docker compose -f docker-compose.yml -f docker-compose.tls.yml -f docker-compose.vault.yml logs vault-agent`. `permission denied` indica política faltando no módulo; `connection refused` do Mongo indica que ele ainda não criou o administrador (aguarde o healthcheck).
- **API no modo Vault com `MONGO_USERNAME_FILE: não foi possível ler`:** o Agent ainda não gravou os arquivos, ou eles foram limpos numa nova subida. Use `npm run docker:infra:vault` antes do `dev:docker:vault`.
- **Kubernetes: pod preso em `Init` (`vault-agent-init`):** o papel `matrixgrid-api-clean-architecture` do `auth/k8s-<ambiente>` não aceita a ServiceAccount ou o namespace do pod, ou a política não cobre um dos caminhos de `vault.files`. Veja os logs do container `vault-agent-init` e o `projects/matrixgrid.yaml` da plataforma.
- **Kubernetes: job `<release>-migrate` falhou:** `kubectl logs job/<release>-migrate -c migrate`. Índice único com dados duplicados precisa de limpeza manual antes.
- **Kong (KIC) responde 502 para a API:** o Kong não confia na CA da API (`kong.upstream.caSecret`) ou não apresenta certificado (`kong.upstream.clientCertSecret`), e a API exige mTLS.
- **`Configuração de TLS inválida:`** na inicialização: a lista diz o que está incoerente (ex.: `RABBITMQ_TLS=true exige RABBITMQ_URI com amqps://`).
- **`TLS: não foi possível ler ... em ./certs/...`:** rode `npm run tls:setup`.
- **`self-signed certificate in certificate chain` / `unable to verify the first certificate`:** o cliente não confia na CA. Defina `TLS_CA_FILE` (ou `<P>_TLS_CA_FILE`) ou use `--cacert certs/ca.crt` no curl.
- **`Hostname/IP does not match certificate's altnames`:** o host da URL não está no certificado. Use um nome que esteja (`localhost`, `127.0.0.1` ou o nome do serviço) ou defina `<P>_TLS_SERVERNAME`.
- **`certificate required` / `tlsv13 alert certificate required`:** o servidor exige certificado de cliente; defina `TLS_CLIENT_CERT_FILE` e `TLS_CLIENT_KEY_FILE` (ou passe `--cert`/`--key`).
- **Kong responde 502 no modo TLS:** o `kong.yml` foi gerado com upstream `http://`, ou a API não está em HTTPS. Use `npm run docker:up:tls` (ou `docker:infra:tls` com `dev:docker:tls`), que gera o `kong.yml` certo.
- **`certs/...` virou uma pasta:** o compose do TLS subiu sem `tls:setup` (o Docker cria a pasta no lugar do arquivo ausente). Apague-a e rode `npm run tls:setup`.
- **Voltar do modo TLS para o normal:** `npm run docker:up` (ou `docker:infra`) recria os containers sem TLS. Os dados nos volumes são os mesmos.
- **Porta do Docker já em uso:** há outro Mongo/Redis local; pare-o ou altere a porta no `docker-compose.yml`.
