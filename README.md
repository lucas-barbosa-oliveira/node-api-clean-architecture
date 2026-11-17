# API Node.js — Express 5 + Clean Architecture

API de exemplo com Express 5, TypeScript rodando nativamente no Node (sem build), Clean Architecture, jobs assíncronos (202 + consulta por polling), camada de background (tasks na inicialização ou agendadas), autenticação JWT com refresh token, revogação de sessões e escopos atrás do Kong Gateway, listagens com filtros/ordenação/paginação pela query string, dispositivos ESP32 pareados por código com dados em série temporal (InfluxDB 2), comunicação entre microsserviços pelo RabbitMQ (publish/subscribe e RPC) com outbox transacional, auditoria de cada requisição, verificações de liveness/readiness, OpenTelemetry (traces e métricas), logs de conexão e reconexão de todas as dependências, CI no GitHub Actions, MongoDB e Redis (BullMQ) opcionais.

[![CI](https://github.com/lucas-barbosa-oliveira/node-api-clean-architecture/actions/workflows/ci.yml/badge.svg)](https://github.com/lucas-barbosa-oliveira/node-api-clean-architecture/actions/workflows/ci.yml)

## Stack

- Node.js ≥ 22.18 (TypeScript nativo via *type stripping*: `node arquivo.ts`)
- Express 5, zod 4, Mongoose 9, BullMQ, croner
- Autenticação: JWT RS256 com `jose`, refresh token opaco com rotação, senhas com `scrypt` (nativo do Node), Kong Gateway 3.9 (DB-less)
- Query string: `query-strings-parser`
- Séries temporais: InfluxDB 2.7 com `@influxdata/influxdb-client`
- Barramento: RabbitMQ 4.1 com `amqplib` (publish/subscribe e RPC, compatível com serviços que usam a `amqp-client-node`), com outbox transacional no MongoDB (replica set)
- Observabilidade: OpenTelemetry (traces para o Jaeger, métricas no formato Prometheus), logs com `trace_id`
- CI: GitHub Actions (lint, typecheck, testes, integração e teste de fumaça da imagem) e Dependabot
- Documentação: OpenAPI 3.1 gerado a partir dos schemas zod, com Swagger UI (`swagger-ui-dist`) em `/reference`
- Testes: `node:test` + supertest

## Pré-requisitos

| Item | Necessário para | Versão |
|---|---|---|
| Node.js + npm | tudo | ≥ 22.18 (recomendado a LTS atual) |
| Docker + Docker Compose | só o modo completo (Mongo + Redis + InfluxDB + Kong) | Compose v2 (`docker compose`) |

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

## Passo a passo — modo completo (Docker)

Persistência em Mongo, fila BullMQ no Redis, dados dos sensores no InfluxDB e o Kong Gateway na frente da API; permite várias instâncias da API em paralelo. Há duas formas de subir:

```bash
# 1) tudo em containers (API construída pelo Dockerfile)
npm run docker:up        # gera chaves JWT e kong/kong.yml; build da imagem; sobe api, mongo, redis, influxdb, rabbitmq e kong
npm run docker:logs      # acompanha os logs da API

# 2) só as dependências em containers; a API roda no host, com --watch
npm run docker:infra     # sobe mongo, redis, influxdb, rabbitmq e kong (Kong aponta para host.docker.internal:3000)
npm run dev:docker       # API com .env.docker, na porta 3000
```

Nos dois casos os clientes acessam pelo Kong, em `http://localhost:8000`. O `requests.http` já aponta para lá, e a documentação interativa fica em `http://localhost:8000/reference`. Para trocar de modo, basta rodar o outro script: o `kong/kong.yml` é regerado e o Kong recriado.

### Imagem da API

O [Dockerfile](Dockerfile) não tem etapa de build: o Node executa os `.ts` de `src/` diretamente, como em desenvolvimento.

- **Duas etapas:** uma instala só as dependências de produção (`npm ci --omit=dev`), a final copia `node_modules`, `package.json` e `src/`. Imagem de ~200 MB em `node:24-alpine`.
- **Fora da imagem:** `.env*`, `keys/`, testes e configurações de lint (veja [.dockerignore](.dockerignore)). As variáveis vêm do `.env.docker` via `env_file`, com os hosts trocados pelos nomes dos serviços (`mongo`, `redis`, `influxdb`); as chaves JWT entram por volume somente leitura.
- **Execução:** usuário `node` (sem root), sistema de arquivos somente leitura, `HEALTHCHECK` em `/health/live` e `CMD ["node", ...]` sem `npm` na frente, para o SIGTERM do `docker stop` chegar ao Node e o encerramento ser gracioso.
- **Porta:** a API não é publicada no host; todo acesso passa pelo Kong. Para chamar direto, descomente `ports` no serviço `api` do `docker-compose.yml`.
- **Escala:** `docker compose up -d --scale api=3` sobe três instâncias; o Kong distribui entre elas pelo DNS do Docker, e os jobs e tasks agendadas continuam coordenados pelo Redis.

Testes com as dependências reais (inclui integração com BullMQ, InfluxDB, RabbitMQ e o outbox transacional). Eles usam banco e fila próprios (`app_test`, prefixo `bull-app_test`), sem misturar com os dados da API de desenvolvimento, mesmo com ela rodando ao lado:

```bash
npm run test:docker
```

Inspecionar:

```bash
docker compose exec mongo mongosh app      # db.users.find(), db.jobs.find()
docker compose exec redis redis-cli        # KEYS bull:*
curl -s localhost:8001/routes | node -pe "JSON.parse(require('fs').readFileSync(0)).data.map(r=>r.name)"  # rotas no Kong
docker compose logs -f kong                # logs de acesso do gateway
# RabbitMQ: interface web em http://localhost:15672 (app / app-rabbit-local)
# Jaeger (traces): http://localhost:16686 | métricas da API: http://localhost:9464/metrics
# Prometheus (opcional): docker compose --profile metrics up -d prometheus -> http://localhost:9090
# InfluxDB: interface web em http://localhost:8086 (admin / admin-influx-local), bucket "sensors"
docker compose exec influxdb influx query --org app --token dev-influx-token-local \
  'from(bucket:"sensors") |> range(start:-1d) |> filter(fn:(r)=> r._measurement=="passage")'
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
| Sessão | A sessão do token ainda está ativa (sem logout/revogação)? | API, a cada requisição |
| Escopo | Este token pode usar esta rota? | API, middleware `guard(...)` em cada rota |
| Dono do recurso | Este usuário pode ver *este* registro? | API, nos services (`JobService`, `UserService`) |

A API valida o token mesmo atrás do Kong (*zero trust*): quem chegar direto na porta 3000 sem token recebe 401.

**Papéis e escopos** (definidos em `src/domain/auth/scopes.ts` e gravados no token no login):

| Papel | Pode | Escopos |
|---|---|---|
| `admin` | cadastrar gestores e clientes; ver qualquer usuário e qualquer job; derrubar sessões de qualquer usuário; gerenciar dispositivos e ver passagens de todos | `users:create` `users:read` `users:read:any` `clients:read` `jobs:read` `jobs:read:any` `sessions:revoke:any` `devices:*` `devices:*:any` `passages:read` `passages:read:any` |
| `manager` | listar clientes; criar jobs associados a um cliente; ver os jobs que criou | `users:read` `clients:read` `jobs:create` `jobs:read` |
| `client` | ver os jobs associados a ele; parear e gerenciar os próprios dispositivos e ver as passagens deles | `users:read` `jobs:read` `devices:read` `devices:manage` `passages:read` |
| dispositivo | só enviar dados do próprio dispositivo | `telemetry:write` |

**Rotas:**

| Rota | Acesso |
|---|---|
| `GET /health`, `/health/live`, `/health/ready`, `GET /.well-known/jwks.json` | pública |
| `POST /auth/login` | pública. `{ email, password }` → `{ access_token, token_type, expires_in, refresh_token, refresh_expires_in }` |
| `POST /auth/refresh` | pública. `{ refresh_token }` → novo par de tokens (o refresh token antigo deixa de valer) |
| `POST /auth/logout` | autenticado: encerra a sessão do token (204) |
| `POST /auth/logout-all` | autenticado: encerra todas as sessões do usuário (`{ revoked }`) |
| `GET /auth/sessions` | autenticado: sessões ativas do usuário, com `current: true` na do token |
| `DELETE /auth/sessions/:id` | autenticado: encerra uma sessão própria (alheia → 404; qualquer uma com `sessions:revoke:any`) |
| `DELETE /users/:id/sessions` | `sessions:revoke:any` (admin): derruba todas as sessões do usuário |
| `POST /users` | `users:create` (admin). Corpo: `{ name, email, password, role: "manager" \| "client" }` |
| `GET /users` | `users:read:any` (admin), com query string |
| `GET /users/me` | autenticado |
| `GET /users/:id` | o próprio id; qualquer id com `users:read:any` |
| `GET /clients` | `clients:read` (admin, gestor), com query string |
| `POST /reports` | `jobs:create` (gestor). Corpo: `{ clientId, month }`; o gestor vem do token |
| `GET /jobs`, `GET /jobs/:id` | gestor vê os que criou, cliente os associados a ele, `jobs:read:any` vê todos. `GET /jobs` aceita query string |
| `POST /clients/:clientId/pairing-codes` | `devices:manage`: o próprio cliente (ou admin) gera o código de pareamento |
| `POST /devices/claim` | pública: a ESP32 troca o código pelo id do cliente e pelo token do dispositivo |
| `GET /devices`, `DELETE /devices/:id` | `devices:read` / `devices:manage`: dispositivos do cliente (admin: todos), com query string |
| `POST /devices/:deviceId/passages` | token do dispositivo (`telemetry:write`): lote de passagens |
| `GET /passages`, `GET /passages/summary` | `passages:read`: passagens dos dispositivos do cliente (admin: todas), com query string |

Recurso de outra pessoa responde **404** (e não 403), para não revelar quais ids existem. Sem escopo para a rota, a resposta é **403**; sem token ou com token inválido, **401**.

### Refresh token e revogação

- **Access token** (JWT, 15 min por padrão) vai em `Authorization: Bearer`. Carrega o id da sessão no claim `sid`.
- **Refresh token** (opaco, 7 dias por padrão) só serve para `POST /auth/refresh`. O formato é `<id da sessão>.<segredo>`, e a API guarda apenas o SHA-256 do segredo.
- **Rotação:** cada refresh token vale uma vez. O refresh devolve um par novo, e o refresh token antigo deixa de valer.
- **Detecção de reuso:** reapresentar um refresh token já usado indica cópia vazada, então a sessão inteira é revogada (o access token dela também). Dois refreshes simultâneos com o mesmo token caem nessa regra. O cliente deve serializar a renovação.
- **Revogação imediata:** a cada requisição a API confere se a sessão do token está ativa. Por isso logout, logout-all e a revogação pelo admin valem na hora, mesmo para access tokens ainda dentro do prazo. O Kong não sabe de revogações (ele só valida a assinatura), e quem recusa é a API.
- A validade da sessão é absoluta: renovar não estende os 7 dias. Depois disso, só com novo login.
- A task `purge-ended-sessions` (todo dia às 03:30) remove sessões encerradas há mais de 7 dias.

### Query string nas listagens

`GET /jobs`, `GET /users` e `GET /clients` usam o [query-strings-parser](https://github.com/nutes-uepb/query-strings-parser):

| Exemplo | Significado |
|---|---|
| `?status=succeeded` | igual a |
| `?status=pending,running` | um dos valores (OU) |
| `?name=*ana*` | contém (`ana*` começa com, `*ana` termina com), sem diferenciar maiúsculas e acentos |
| `?createdAt=gte:2026-10-01` | operadores `gt`, `gte`, `lt`, `lte`, `ne` |
| `?start_at=2026-10-01&end_at=2026-11-01` | intervalo em `createdAt` (o `end_at` não entra no intervalo) |
| `?period=7d` | últimos 7 dias (`d`, `w`, `m`, `y`) |
| `?sort=-createdAt,status` | ordenação (`-` = decrescente) |
| `?fields=id,status,clientId` | campos da resposta |
| `?page=2&limit=10` | paginação (padrão 20 itens, máximo 100). O total vem no header `X-Total-Count` |

Cada recurso declara o que pode ser filtrado, ordenado e selecionado (`src/application/query/*.query.schema.ts`). Qualquer outro campo, operador ou valor fora do tipo responde 400 com a lista de problemas. Isso impede, por exemplo, filtrar por `passwordHash` ou injetar operadores do Mongo. Metacaracteres de regex são recusados (só `*` é curinga), para evitar ReDoS. A restrição de acesso do usuário é combinada com `$and` ao filtro da query string, então nenhum filtro amplia o que ele pode ver.

O middleware da biblioteca não é usado, porque ele sobrescreve `req.query`, que é somente leitura no Express 5. A API chama `parser()` diretamente (`src/presentation/http/query/list.query.parser.ts`).

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

- O código tem 8 caracteres sem os ambíguos (0/O, 1/I/L), aceita minúsculas e com ou sem hífen. O banco guarda só o hash. Ele expira em `PAIRING_CODE_TTL_SECONDS` e vale uma vez só (troca atômica). O Kong limita `/devices/claim` a 10 tentativas por minuto por IP.
- O `client_id` devolvido vai no payload de cada envio, e a API confere se é o mesmo do dispositivo (senão, 403). O que autentica é o **token do dispositivo**: o id do cliente não é segredo e, sozinho, permitiria que qualquer um gravasse dados em nome de outro cliente.
- O token do dispositivo é um JWT (validade `DEVICE_TOKEN_TTL_SECONDS`, padrão 1 ano) que só serve para `POST /devices/:próprio-id/passages`. O Kong o valida na rota de envio e o recusa nas demais, que aceitam tokens de até 24h.
- Revogar o dispositivo (`DELETE /devices/:id`) invalida o token na hora: a API confere o dispositivo a cada envio. Parear de novo o mesmo hardware (`hardwareId`, o MAC) revoga o registro anterior.

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
| `events` | de 1 a 500 eventos (a ESP32 guarda offline e envia em lote) |
| `eventId` | UUID gerado na ESP32: reenviar o mesmo evento não duplica |
| `occurredAt` | ISO 8601 com fuso; até 5 min no futuro (relógio por NTP) e até 30 dias no passado |
| `direction` | `in`, `out` ou `unknown` |
| `sequence` | opcional, contador crescente (mostra eventos perdidos) |
| `device` | opcional: saúde do dispositivo |

Resposta `202 { "accepted": n }`. A ESP32 pode apagar do buffer local tudo o que enviou.

### Modelo no InfluxDB (bucket `sensors`)

| Medição | Tags (indexadas) | Fields | Tempo |
|---|---|---|---|
| `passage` | `clientId`, `deviceId`, `direction` | `count=1i`, `eventId`, `sequence`, `receivedAtMs` | `occurredAt` |
| `device_status` | `clientId`, `deviceId` | `firmware`, `uptimeSeconds`, `rssi` | recebimento |

Um ponto é identificado por medição, tags e tempo, então reenviar o mesmo evento sobrescreve o ponto (gravação idempotente). O `eventId` fica em field para não aumentar a cardinalidade. Dados com mais de 400 dias são apagados pela retenção do bucket.

### Consulta

- `GET /passages?deviceId=...&direction=in&start_at=2026-11-01T00:00:00&end_at=2026-11-02T00:00:00&sort=-occurredAt&page=1&limit=50` lista as passagens, com o total em `X-Total-Count`. Dá para filtrar por `deviceId`, `clientId`, `direction` e o período (`occurredAt`, `start_at`/`end_at`/`period`).
- `GET /passages/summary?window=1h&start_at=...&deviceId=...` devolve `{ window, windows: [{ start, in, out, unknown }] }`, com zero nas janelas sem evento. Sem início, considera as últimas 24h. O fim é limitado ao instante atual. São no máximo 1000 janelas, e o `window` vai de `1m` a `31d`.
- Datas sem fuso na query string usam o fuso do servidor. Em servidores fora de UTC, o `period` da biblioteca pode começar um dia antes. Para intervalos exatos, use `start_at`/`end_at` com horário.

Os filtros viram Flux com os valores escapados pela biblioteca oficial e já validados (UUIDs e enums). Sem InfluxDB (`TIMESERIES_DRIVER=memory`), um armazenamento em memória reproduz o mesmo comportamento, inclusive as janelas.

### Kong

Configuração em `kong/kong.template.yml`, modo DB-less:

- `jwt` nas rotas protegidas: valida assinatura RS256 e `exp`, recusa validade acima de 24h e só aceita o token no header `Authorization`.
- `rate-limiting`: 10 logins/min por IP (freia tentativa de adivinhar senha), 30 refreshes/min, 10 pareamentos/min, 120 envios de dispositivo/min e 300 req/min nas rotas protegidas (todos por IP).
- `jwt` também na rota de envio dos dispositivos (`~/devices/[^/]+/passages$`), aceitando a validade longa do token do dispositivo.
- `request-size-limiting` (128 KB) e `correlation-id` (`X-Request-ID` em todas as respostas).

Quem emite os tokens é a própria API, assinando com a chave privada. O Kong só tem a chave pública, cadastrada em um consumer cuja `key` é o `iss` do token (`JWT_ISSUER`). `npm run kong:setup` gera o par de chaves em `keys/` (ignorado pelo git) e monta `kong/kong.yml` a partir do template.

## Documentação da API (OpenAPI)

| URL | Conteúdo |
|---|---|
| `/reference` | Swagger UI: documentação navegável e testes ("Try it out" já vem aberto) |
| `/reference/openapi.json` | Documento OpenAPI 3.1 |
| `/reference/openapi.yaml` | O mesmo documento, em YAML (para Postman, Insomnia, geradores de cliente) |

Pelo Kong: `http://localhost:8000/reference`. Direto na API: `http://localhost:3000/reference`.

**Teste rápido:**
1. Abra **POST /auth/login** e clique em *Execute*. O exemplo já traz o admin local.
2. O `access_token` da resposta entra sozinho em *Authorize* e continua lá se a página for recarregada.
3. Chame qualquer rota protegida. Para testar outro papel, faça login com outro usuário.

O mesmo vale para **POST /devices/claim**: o token do dispositivo entra em *Authorize*, e dá para enviar passagens como se fosse a ESP32. O logout remove o token.

**Como o documento é gerado:** é montado em código ([document.ts](src/presentation/http/openapi/document.ts)), sem anotações espalhadas, a partir de fontes que já existem:
- **Corpos de requisição:** vêm dos mesmos schemas zod da validação (`z.toJSONSchema`). Mudou o schema, mudou a documentação.
- **Parâmetros de listagem:** filtros, ordenação, campos, paginação e intervalo de datas saem do `QuerySchema` de cada recurso, a mesma whitelist que valida a query string.
- **Quem pode chamar:** "Escopo: `jobs:read` — administrador, gestor, cliente" é calculado de `ROLE_SCOPES`.
- **Respostas:** escritas à mão em [components.ts](src/presentation/http/openapi/components.ts), porque são o formato público da API.

**Como fica sincronizado:** os testes em [openapi.test.ts](test/http/openapi.test.ts) conferem que:
- o documento é um OpenAPI 3.1 válido;
- toda rota registrada no Express está documentada, e toda rota documentada existe;
- as respostas reais de cada rota, incluindo os erros (400, 401, 403, 404, 409), seguem os schemas documentados. Um campo novo na resposta sem documentação faz o teste falhar.

Para desligar a documentação (ex.: em produção), use `API_DOCS_ENABLED=false`. As rotas de documentação não são auditadas e os arquivos estáticos só aparecem no log em `debug`.

## Logs

Cada linha tem o nome do serviço (`APP_NAME`), a data, o nível e o componente:

```
api-clean-architecture @ 2026-11-17T14:14:25.768Z info: [mongodb] Conexão com MongoDB estabelecida
api-clean-architecture @ 2026-11-17T14:14:26.452Z info: [rabbitmq] Conexão RabbitMQ (publish) estabelecida
api-clean-architecture @ 2026-11-17T14:14:26.452Z info: [rabbitmq] Recurso RPC users.find registrado
api-clean-architecture @ 2026-11-17T14:14:26.445Z info: [http] ::ffff:127.0.0.1 - "POST /auth/login HTTP/1.1" 200 1404 92.515 ms "-" "curl/7.68.0"
api-clean-architecture @ 2026-11-17T14:14:26.482Z info: [rabbitmq] Evento RequestAuditEvent publicado em audit (audit.request)
```

- **Nível e formato:** `LOG_LEVEL` (`silent`, `error`, `warn`, `info`, `debug`) e `LOG_FORMAT` (`text` ou `json`, uma linha JSON por log para Loki, ELK ou CloudWatch). As cores só aparecem em terminal; `NO_COLOR` desliga e `FORCE_COLOR` liga.
- **Implementação:** a aplicação depende da porta `ILogger` (`application/port/logger.ts`); a implementação é `infrastructure/logger/console.logger.ts`, sem dependências. Trocar por winston ou pino é escrever outro adaptador.
- **Requisições:** uma linha por requisição no formato *combined* com o tempo de resposta. `/health` e `/health/*` (chamados pelo Docker e pelo balanceador) só aparecem em `debug`.
- **Erros não tratados:** saem com o stack e o `request_id`.
- **Correlação com traces:** com o OpenTelemetry ligado, cada linha registrada dentro de uma requisição ou mensagem termina com `trace_id=...`, o id para buscar o trace no Jaeger (em JSON, campos `trace_id` e `span_id`).

### Conexões e reconexões

| Dependência | Na inicialização | Durante a execução |
|---|---|---|
| MongoDB | Tenta até conseguir (espera dobra até 15 s), registrando cada falha; a API só aceita tráfego depois | O driver reconecta sozinho; registra a queda, as tentativas que falham (no máximo uma a cada 5 s) e o retorno |
| Redis | Espera as 4 conexões (filas e workers de jobs e tasks) | O ioredis reconecta sozinho; registra queda, cada tentativa (com o último erro) e retorno por conexão |
| InfluxDB | Não bloqueia: um `GET /ping` periódico registra a conexão | Mesmo `ping` (a cada 15 s; 5 s enquanto fora do ar) registra queda, tentativas e retorno; falhas de gravação também viram log |
| RabbitMQ | Não bloqueia: conecta em segundo plano e registra cada tentativa com o motivo (recusa, credenciais, vhost) | A biblioteca reconecta para sempre e refaz exchanges, filas e consumidores; registra queda, tentativas e retorno por conexão (publish, subscribe, RPC server, RPC client) |

Um `docker stop` durante as tentativas de conexão encerra a aplicação na hora. No encerramento normal, a instância deixa de estar pronta (`/health/ready` responde 503) e cada etapa é registrada: servidor HTTP, filas, relay do outbox, barramento, InfluxDB e MongoDB.

## Barramento de eventos (RabbitMQ)

Comunicação com outros microsserviços pelo `amqplib`, atrás da porta `IEventBus` (`application/port/event.bus.ts`). Com `EVENT_BUS_DRIVER=memory` (padrão fora do Docker), um barramento dentro do processo faz o mesmo papel, sem RabbitMQ.

| Papel | Onde | Detalhes |
|---|---|---|
| Publicar | Services gravam no outbox (`IOutbox`); o relay chama `eventBus.publish` | Exchange `topic` durável, mensagem persistente e confirmação do broker (*publisher confirms*): só conta como enviada quando o RabbitMQ aceitou |
| Assinar | `presentation/eventbus/subscribers.ts` | Cada subscriber declara `eventName`, `exchange` e `routingKey` (aceita `*` e `#`) e chama um service. Todos usam a fila durável `<APP_NAME>`. Confirmação (ack) depois do processamento; se o handler falhar, a mensagem é descartada com log, sem voltar à fila |
| Oferecer RPC | `presentation/eventbus/rpc.resources.ts` | Exchange `direct` `<APP_NAME>.rpc`. Recursos: `users.find(query)`, `users.findone(id)` e `jobs.find(query)`. As consultas aceitam a mesma query string das rotas, validada pelo mesmo schema |
| Chamar RPC | `eventBus.executeResource(servico, recurso, ...params)` | Chama `<servico>.rpc` por *direct reply-to*. Recurso inexistente falha na hora (mensagem devolvida pelo broker); sem resposta, falha após `RABBITMQ_RPC_TIMEOUT_MS` |

Exemplo de outro serviço chamando esta API: `executeResource('api-clean-architecture', 'users.find', '?role=client&fields=name,email')`. Erros (ex.: query string inválida ou usuário inexistente) voltam como erro para quem chamou, em vez de virar *timeout*.

- **Compatível com a `amqp-client-node`.** Usa o mesmo formato de mensagem (JSON), a mesma convenção de RPC (`{ resource_name, handle }` e `type: "error"` nas falhas) e os mesmos argumentos de fila. O teste de integração `test/integration/rabbitmq.test.ts` usa a biblioteca dos serviços antigos para provar as duas direções.
- **Duas conexões, como recomenda o RabbitMQ:** `publish` (publicação e RPC client) e `consume` (subscribers e servidor RPC). Assim, um consumidor lento não atrasa as publicações.
- **Reconexão:** a reconexão é própria, para sempre, com espera que dobra até 15 s. Cada tentativa é registrada com o motivo real (recusa, credenciais, vhost, fila incompatível). A cada reconexão, exchanges, filas, ligações e consumidores são refeitos.
- **Acesso por RPC:** o RPC não passa pelo Kong nem tem token. Quem alcança o RabbitMQ lê usuários e jobs, então o broker deve ficar só na rede interna dos serviços, com usuário e senha próprios.

### Outbox transacional

Os services nunca publicam direto no barramento: gravam o evento na coleção `outbox_events`, **na mesma transação** que o dado que mudou (`IUnitOfWork`). Um relay publica em seguida.

```
POST /users ──► transação { insert users, insert outbox_events } ──► 201
                                         │
                         relay (a cada evento novo ou 1 s) ──► RabbitMQ (confirmado) ──► marca como enviado
```

- **Garantias:** o evento só existe se o dado foi gravado, e nunca se perde com o RabbitMQ fora do ar ou com a API reiniciando, porque fica no banco esperando. Há novas tentativas com espera crescente, até 5 minutos.
- **Entrega "pelo menos uma vez":** se a instância cair entre publicar e marcar como enviado, o evento sai de novo com o mesmo `messageId`. Os consumidores descartam repetidos pelo `messageId` (ou pelo `audit.id`).
- **Várias instâncias:** cada evento é reservado por uma só (`findOneAndUpdate` atômico), sem envio duplicado.
- **Trace contínuo:** o relay publica dentro do trace de quem gravou o evento, então requisição e publicação aparecem no mesmo trace no Jaeger.
- **Limpeza:** eventos enviados ficam 7 dias (índice TTL) para investigação. Pendentes e idade do mais antigo aparecem em `/health/ready` e nas métricas `outbox_events_pending` e `outbox_oldest_pending_age`.
- **Replica set obrigatório:** o MongoDB precisa ser replica set para ter transações. O compose já sobe assim (`--replSet rs0`, iniciado pelo healthcheck), e a URI usa `?directConnection=true`. Com um `mongod` avulso, a API funciona, mas avisa no log que dado e evento não serão atômicos.
- **Implementação:** `transactionAsyncLocalStorage` do Mongoose, que repassa a sessão da transação a todas as operações do callback sem mudar nenhum repositório.

Eventos publicados por este serviço:

| Exchange | Routing key | Evento | Quando |
|---|---|---|---|
| `users` | `users.created` | `UserCreatedEvent` | Admin cadastra gestor ou cliente |
| `devices` | `devices.paired` | `DevicePairedEvent` | ESP32 pareada |
| `devices` | `devices.revoked` | `DeviceRevokedEvent` (`reason`: `revoked_by_user` ou `replaced_by_new_pairing`) | Cliente revoga, ou o mesmo hardware é pareado de novo |
| `audit` | `audit.request` | `RequestAuditEvent` | Cada requisição (ver abaixo) |

### Auditoria

A cada requisição (exceto `AUDIT_IGNORE_PATHS`, por padrão `/health`, `/.well-known` e `/reference`), a API grava no outbox e publica um `RequestAuditEvent` na exchange `audit` com routing key `audit.request`. O serviço de auditoria assina com uma fila ligada a `audit.#`.

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
      "method": "POST", "path": "/jobs", "route": "/jobs", "params": {}, "query": {},
      "body": { "type": "report", "clientId": "..." },
      "ip": "172.18.0.1", "user_agent": "Mozilla/5.0 ..."
    },
    "response": { "status_code": 202, "body": { "id": "...", "status": "pending" } },
    "started_at": "2026-11-17T14:17:22.769Z",
    "finished_at": "2026-11-17T14:17:22.903Z",
    "duration_ms": 134
  }
}
```

- **Quem:** `actor` sai do token (usuário ou dispositivo) e vem `null` em login e em requisições recusadas (401). As recusas (401, 403, 404, 400 de JSON malformado) também são auditadas.
- **Segredos:** senhas, tokens (`access_token`, `refresh_token`, `Authorization`) e o código de pareamento viram `[REDACTED]` antes de sair da API.
- **Tamanho:** corpos acima de `AUDIT_MAX_BODY_BYTES` (ex.: listagens grandes) vão só com o tamanho (`{ "_truncated": true, "_size_bytes": ... }`).
- **Correlação:** `request_id` é o `X-Request-ID` gerado pelo Kong (plugin `correlation-id`) ou um novo, se a chamada vier direto. Ele volta no header da resposta e permite cruzar os logs do gateway, da API e da auditoria.
- **Duplicatas:** `audit.id` é único por evento. Após uma queda do barramento, um evento pode chegar duas vezes; o consumidor descarta pelo `id`.
- **Desligar:** `AUDIT_ENABLED=false`.

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
  "outbox":   { "status": "up", "critical": false, "latency_ms": 3, "details": { "pending": 0, "oldestAgeSeconds": 0 } } } }
```

- **Dependências críticas:** MongoDB e Redis. Fora do ar, a instância não está pronta.
- **Não críticas:** InfluxDB, RabbitMQ e outbox aparecem no relatório sem tirar a instância do ar. Com o RabbitMQ fora, os eventos esperam no outbox. O outbox fica `down` se um evento estiver parado há mais de 5 minutos.
- **Tempo máximo:** cada verificação tem 2 s; uma dependência travada conta como `down`.
- **Encerramento:** no SIGTERM, a readiness passa a responder 503 antes de as conexões fecharem.
- **Dependência fora do ar responde 503, não 500.** Banco, fila ou barramento indisponível vira `503 { "code": "UNAVAILABLE" }` com `Retry-After: 5`, registrado como `warn` sem stack. O cliente sabe que pode tentar de novo, e o 500 fica reservado para bugs. A infraestrutura reconhece os erros dos drivers (`infrastructure/resilience/unavailable.ts`); a camada HTTP não conhece nenhum driver.

## Observabilidade (OpenTelemetry)

Ligado quando `OTEL_EXPORTER_OTLP_ENDPOINT` está definido (já está no `.env.docker` e no compose). Carregado antes da aplicação com `node --import ./src/main/telemetry.ts` (os scripts npm e o Dockerfile já fazem isso).

| Sinal | Onde ver | Conteúdo |
|---|---|---|
| Traces | Jaeger, `http://localhost:16686` | Kong → API → MongoDB, Redis, RabbitMQ: um trace por requisição, do gateway ao banco, incluindo a publicação feita depois pelo outbox |
| Métricas | `http://localhost:9464/metrics` (Prometheus); Prometheus opcional em `:9090` com `docker compose --profile metrics up -d prometheus` | Latência HTTP (`http_server_request_duration`), event loop, heap, GC, conexões do Mongo, `outbox_events_pending`, `outbox_oldest_pending_age`, `outbox_events_published_total`, `jobs_completed_total`, `jobs_duration`, `passages_written_total` |
| Logs | stdout | `trace_id` em cada linha registrada dentro de um trace |

- **Instrumentação automática:** HTTP, Express, MongoDB, ioredis (BullMQ) e amqplib. O contexto do trace segue nos headers das mensagens do RabbitMQ, então um serviço que consome e também usa OpenTelemetry continua o mesmo trace.
- **Fora dos traces:** `/health/*`, os arquivos da documentação e `/metrics` não geram trace (só ruído). Os spans do MongoDB não gravam os valores das consultas.
- **Kong:** o plugin `opentelemetry` envia os spans do gateway ao Jaeger e passa o contexto adiante pelo header `traceparent` (W3C).
- **Métricas de negócio:** ficam em `infrastructure/telemetry/metrics.ts`. Sem o SDK carregado (testes, modo rápido), a API do OpenTelemetry não faz nada e não custa nada.
- **Variáveis padrão do OpenTelemetry:** `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` (amostragem em produção), `OTEL_SDK_DISABLED`.

## Integração contínua

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) roda a cada push em `main`/`develop` e em todo pull request:

| Job | O que faz |
|---|---|
| `quality` | `npm ci`, lint, typecheck e testes em memória |
| `integration` | Sobe MongoDB (replica set), Redis, InfluxDB e RabbitMQ com o compose e roda `npm run test:docker` (inclui outbox transacional e compatibilidade com a `amqp-client-node`) |
| `image` | `npm run docker:up` (build da imagem + ambiente completo) e teste de fumaça pelo Kong: readiness, documentação e login |

Em falha, o job imprime os logs dos containers. Um push novo na mesma branch cancela a execução anterior. O [Dependabot](.github/dependabot.yml) abre pull requests semanais com atualizações de npm (OpenTelemetry e ESLint agrupados), actions e imagens Docker.

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
| `JWT_EXPIRES_IN_SECONDS` | `900` | Validade do access token (60 a 86400) |
| `REFRESH_TOKEN_TTL_SECONDS` | `604800` | Validade absoluta da sessão / refresh token (1h a 90 dias) |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Administrador criado na inicialização, se ainda não existir |
| `TIMESERIES_DRIVER` | `memory` | `memory` ou `influx` |
| `INFLUX_URL` / `INFLUX_TOKEN` / `INFLUX_ORG` / `INFLUX_BUCKET` | — | Obrigatórias com `influx` |
| `PAIRING_CODE_TTL_SECONDS` | `600` | Validade do código de pareamento (60 a 3600) |
| `DEVICE_TOKEN_TTL_SECONDS` | `31536000` | Validade do token do dispositivo (1 a 365 dias) |
| `APP_NAME` | `api-clean-architecture` | Nome do serviço: rótulo dos logs, `service` da auditoria, fila `<APP_NAME>` e exchange RPC `<APP_NAME>.rpc` |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `text` | Nível (`silent`, `error`, `warn`, `info`, `debug`) e formato (`text` ou `json`) |
| `EVENT_BUS_DRIVER` | `memory` | `memory` ou `rabbitmq` |
| `RABBITMQ_URI` | — | Obrigatória com `rabbitmq`, ex.: `amqp://app:app-rabbit-local@127.0.0.1:5672` |
| `RABBITMQ_RETRY_INTERVAL_MS` / `RABBITMQ_RPC_TIMEOUT_MS` | `2000` / `5000` | Intervalo entre tentativas de reconexão / tempo máximo de uma chamada RPC |
| `QUEUE_PREFIX` | `bull` | Prefixo das chaves do BullMQ no Redis; separa ambientes no mesmo Redis (os testes usam `bull-<banco>`) |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Intervalo com que o relay procura eventos gravados por outras instâncias (os desta instância saem na hora) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | Liga o OpenTelemetry e define para onde vão os traces (ex.: `http://127.0.0.1:4318`) |
| `OTEL_SERVICE_NAME` / `OTEL_METRICS_PORT` | `APP_NAME` / `9464` | Nome do serviço nos traces / porta do `/metrics` |
| `AUDIT_ENABLED` / `AUDIT_IGNORE_PATHS` / `AUDIT_MAX_BODY_BYTES` | `true` / `/health,/.well-known,/reference` / `16384` | Auditoria por requisição |
| `API_DOCS_ENABLED` | `true` | Swagger UI e documento OpenAPI em `/reference` |
| `KONG_UPSTREAM_URL` | `http://api:3000` | Só para `npm run kong:setup`: onde o Kong encontra a API (`docker:infra` usa `http://host.docker.internal:3000`) |

`.env.docker` está versionado de propósito: contém apenas valores locais (inclusive a senha do admin de desenvolvimento). As chaves ficam em `keys/`, fora do git.

## Scripts npm

| Script | O que faz |
|---|---|
| `npm run dev` | API com `--watch` (lê `.env` se existir) |
| `npm start` | API sem watch |
| `npm run dev:docker` / `start:docker` | Igual, usando `.env.docker` |
| `npm run docker:up` | Sobe tudo em containers, incluindo a API (com build da imagem) |
| `npm run docker:infra` | Sobe só Mongo, Redis, InfluxDB, RabbitMQ e Kong; a API roda no host |
| `npm run docker:build` / `docker:logs` | Build da imagem da API / logs da API |
| `npm run docker:down` | Para os containers |
| `npm test` | Testes (o que depende de Redis é ignorado sem `REDIS_URL`) |
| `npm run test:docker` | Testes contra Mongo/Redis do compose |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7) |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run kong:setup` | Gera as chaves JWT (se faltarem) e `kong/kong.yml` |

## Estrutura

```
src/
  domain/          regras de negócio puras
    auth/ error/ model/ validator/ utils/
  application/     casos de uso e portas
    service/ port/ query/ (consultas de listagem e o que cada recurso aceita)
    audit/             evento de auditoria e remoção de segredos
    event/             eventos de integração publicados por este serviço
  infrastructure/  detalhes técnicos
    database/schema/   schemas Mongoose
    mapper/            modelo <-> JSON do Mongo (transform)
    repository/        base/ (BaseMongoRepository), mongo/, in-memory/
    queue/ redis/
    eventbus/          RabbitMQ (amqplib, conexão com reconexão) e barramento em memória
    outbox/            outbox (Mongo e memória) e relay que publica no barramento
    telemetry/         métricas de negócio (OpenTelemetry)
    logger/            logger de console (texto ou JSON)
    resilience/        tentativas de conexão na inicialização
    security/          hash de senha (scrypt), JWT (jose) e refresh token
    timeseries/        InfluxDB (Flux) e versão em memória
  background/      tasks (startup/agendadas), schedulers, handlers de jobs
  presentation/
    http/            controllers, rotas, error handler, request id, log de acesso, auditoria
      openapi/       documento OpenAPI e Swagger UI (/reference)
    eventbus/        subscribers e recursos RPC (as "rotas" do barramento)
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
- **Nova rota (qualquer):** documente em `presentation/http/openapi/document.ts`; o teste de cobertura falha enquanto ela não estiver lá.
- **Nova rota protegida:** crie o escopo em `domain/auth/scopes.ts`, conceda-o aos papéis em `ROLE_SCOPES` e use `guard(SCOPES.x)` na rota. Regras de dono do recurso vão no service. Se o prefixo da rota for novo, inclua-o em `paths` da rota `protected` em `kong/kong.template.yml` e rode `npm run kong:setup && docker compose restart kong`.
- **Novo subscriber:** adicione `{ eventName, exchange, routingKey, handle }` em `presentation/eventbus/subscribers.ts`, chamando um service. Ele aparece nos logs ao conectar.
- **Novo recurso RPC:** adicione `{ name, handle }` em `presentation/eventbus/rpc.resources.ts`.
- **Publicar um evento de domínio:** injete `IEventBus` no service e chame `publish(exchange, routingKey, { event_name, timestamp, ... })`.
- **Nova task de background:** arquivo em `background/tasks/` com `{ name, runOnStartup?, schedule?, run(signal) }` e adicionar em `tasks/index.ts`.

## Problemas comuns

- **`.env not found. Continuing without it.`:** aviso normal do Node quando não há `.env`; os padrões são usados.
- **`EADDRINUSE`:** porta ocupada; use `PORT=3001 npm run dev`.
- **Erro de sintaxe ao importar `.ts` / `ERR_UNKNOWN_FILE_EXTENSION`:** Node antigo; atualize para ≥ 22.18.
- **`ECONNREFUSED` em 27017/6379:** rode `npm run docker:up` antes e confirme com `docker compose ps`.
- **`QUEUE_DRIVER=redis requires REPOSITORY_DRIVER=mongo`:** combinação inválida de propósito; jobs em memória não seriam visíveis entre instâncias.
- **Kong responde 401 `Unauthorized` para um token emitido pela API:** a API está com chaves temporárias ou diferentes das do Kong. Confira `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEY_PATH` no `.env` usado e rode `npm run kong:setup && docker compose restart kong`.
- **Kong responde 502 / `An invalid response was received from the upstream server`:** com `docker:up`, veja `npm run docker:logs` (a API pode ter falhado ao iniciar). Com `docker:infra`, a API não está rodando na porta 3000 do host, ou um firewall (ex.: `ufw`) bloqueia o acesso vindo da rede do Docker.
- **API no container falha com `EACCES` em `keys/jwt.private.pem`:** a chave privada tem permissão 0600 e a imagem roda com o uid 1000. Se o seu usuário no host tiver outro uid, rode `sudo chown 1000 keys/jwt.private.pem` ou ajuste `user:` no serviço `api`.
- **Kong não sobe e `kong/kong.yml` virou uma pasta:** o compose foi iniciado sem rodar `npm run kong:setup` antes. Apague a pasta e use `npm run docker:up`.
- **`429 API rate limit exceeded` no login:** limite de 10 tentativas por minuto do Kong; aguarde um minuto.
- **Refresh respondendo 401 logo após funcionar:** o mesmo refresh token foi enviado duas vezes (ex.: duas abas renovando ao mesmo tempo), e a sessão foi revogada por reuso. Faça login de novo e serialize a renovação no cliente.
- **ESP32 recebe 401 em `/devices/claim`:** código digitado errado, expirado (10 min) ou já usado. Gere outro.
- **ESP32 recebe 400 com "Data no futuro" ou "mais de 30 dias":** o relógio não foi sincronizado. Configure NTP (`configTime`) antes de registrar eventos.
- **ESP32 recebe 403 no envio:** o `clientId` do payload não é o devolvido no pareamento, ou o `deviceId` da URL não é o do token.
- **ESP32 recebe 401 no envio:** o dispositivo foi revogado ou pareado de novo. Pareie outra vez.
- **`ECONNREFUSED` em 8086:** InfluxDB fora do ar; `npm run docker:up`.
- **`ACCESS_REFUSED` ao conectar no RabbitMQ:** usuário ou senha errados em `RABBITMQ_URI`. O usuário `guest` só funciona de dentro do container; use `app` / `app-rabbit-local`. Se o volume `rabbitmq-data` foi criado com outro usuário, apague-o (`docker compose down -v`).
- **"Barramento indisponível: eventos ficam no outbox" logo na inicialização:** é normal se o relay rodar antes de a conexão com o RabbitMQ abrir. Os eventos saem assim que ela abre.
- **"MongoDB sem replica set" no log:** o Mongo foi iniciado sem `--replSet` (ex.: um container antigo). Recrie com `docker compose up -d mongo` e use `?directConnection=true` na `MONGO_URI`.
- **`/health/ready` responde 503:** veja no corpo qual dependência crítica está `down`.
- **Nenhum trace no Jaeger:** confirme `OTEL_EXPORTER_OTLP_ENDPOINT` e que a API subiu com `--import ./src/main/telemetry.ts`. O log de inicialização mostra `[telemetry] traces para ...`.
- **`EADDRINUSE :9464` com duas instâncias no host:** dê a cada uma um `OTEL_METRICS_PORT` diferente.
- **Ver os logs da aplicação nos testes:** `TEST_LOG_LEVEL=info npm test`.
- **`400` em uma listagem:** a resposta traz em `issues` o campo, operador ou valor recusado.
- **Docker: porta já em uso:** você tem outro Mongo/Redis local; pare-o ou altere a porta em `docker-compose.yml`.

## Notas para produção

- Handlers de job devem ser idempotentes (BullMQ pode reexecutar após falha; há 3 tentativas com backoff).
- Redis com `maxmemory-policy noeviction` e persistência (já no compose).
- `recoverStale` (jobs `running` órfãos após queda) só se aplica ao modo em processo e instância única.
- Chaves e senha do admin: em produção, use um gerenciador de segredos em vez de arquivos e `.env`; troque as chaves periodicamente (o `kid` do token muda junto) e atualize o Kong.
- Para vários microserviços, eles validam os tokens com a chave pública (`/.well-known/jwks.json`); só o emissor tem a chave privada.
- A checagem de sessão é uma consulta por requisição (por `_id`). Com muito tráfego, dá para pôr um cache curto em Redis, aceitando alguns segundos de atraso na revogação.
- Clientes web: guarde o refresh token em cookie `HttpOnly`/`Secure`/`SameSite=Strict`, e não em `localStorage`.
- Com várias instâncias do Kong, troque o `policy: local` do `rate-limiting` por `redis` para o limite ser compartilhado.
- O `INFLUX_TOKEN` local é o de administração. Em produção, crie um token só com leitura e escrita no bucket `sensors` (`influx auth create --read-bucket ... --write-bucket ...`).
- Firmware da ESP32: use HTTPS (`WiFiClientSecure` com o certificado da CA), guarde o token no NVS (`Preferences`) e envie em lote com retentativa. Em 401, volte ao modo de pareamento.
- RabbitMQ: troque a senha de `app`, use `amqps://` entre redes e configure uma *dead-letter exchange* na fila do serviço para guardar mensagens cujo processamento falhou (hoje são descartadas com log).
- O outbox grava um documento por requisição auditada. Com muito tráfego, acompanhe o tamanho de `outbox_events` (enviados expiram em 7 dias) ou envie a auditoria por um caminho próprio.
- Em produção, configure a amostragem de traces (`OTEL_TRACES_SAMPLER=parentbased_traceidratio`, `OTEL_TRACES_SAMPLER_ARG=0.1`) e aponte `OTEL_EXPORTER_OTLP_ENDPOINT` para um OpenTelemetry Collector.
- Use `/health/ready` como *readiness probe* e `/health/live` como *liveness probe* (Kubernetes) ou nos health checks ativos do balanceador.
- Em produção, gerencie índices do Mongo por migração em vez de depender de `autoIndex`; adicione autenticação ao Mongo/Redis (o compose local não tem).
