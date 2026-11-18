# Chart Helm: api-clean-architecture

Implanta a API no Kubernetes:
- **Segredos:** segredos, credenciais dinâmicas e certificados entregues pelo **Vault Agent Injector**.
- **Exposição:** pelo **Kong Ingress Controller**.
- **Dados:** migração de índices do MongoDB em **job** antes de cada versão.
- **Escala e rede:** HPA, PDB e NetworkPolicy.
- **Monitoramento (opcional):** ServiceMonitor e PrometheusRule com os alertas de SLO.

```bash
helm upgrade --install api deploy/helm/api-clean-architecture -n api --create-namespace \
  -f values-production.yaml --set image.tag=$GIT_SHA --wait --timeout 10m
```

## O que precisa existir no cluster (responsabilidade da plataforma)

| Item | Para quê | Observação |
|---|---|---|
| Vault (ou OpenBao) com o módulo [`infra/vault`](../../../infra/vault) aplicado | Segredos, PKI, credenciais dinâmicas, Transit | Papel `api` do Kubernetes auth com as ServiceAccounts `<release>` e `<release>-migrate` |
| Vault Agent Injector | Injeta o Agent nos pods (anotações `vault.hashicorp.com/*`) | Agent ≥ 1.13 (função `pkiCert`) |
| Kong Ingress Controller ≥ 3.4 | Rotas, JWT, rate limit, `konghq.com/ca-certificates-secrets` | `ingressClassName: kong` |
| Secret `kong.tls.secretName` | Certificado público do host (ex.: cert-manager + Let's Encrypt) | |
| Secret `kong.upstream.clientCertSecret` | Certificado do Kong para falar com a API (mTLS) | TLS (`tls.crt`/`tls.key`) emitido pelo papel `infra` do Vault (ex.: cert-manager com emissor Vault) |
| Secret `kong.upstream.caSecret` | CA raiz do Vault, para o Kong verificar a API | Chave `ca.crt`, rótulo `konghq.com/ca-cert: "true"` |
| MongoDB (replica set), Redis, RabbitMQ, InfluxDB | Dependências | TLS com certificados do papel `infra` do Vault; endereços em `config.*` |
| Coletor OpenTelemetry (opcional) | Traces, métricas e logs por OTLP | `config.OTEL_EXPORTER_OTLP_ENDPOINT` |
| Prometheus Operator (opcional) | `metrics.serviceMonitor` e `metrics.prometheusRule` | |

## Como a API recebe segredos

O Agent grava arquivos em `/vault/secrets` e a API os lê pelas variáveis `*_FILE` e `*_PATH`. Os nomes e as origens estão em [`files/vault/README.md`](files/vault/README.md).

| Tipo | Arquivos | Renovação |
|---|---|---|
| Credenciais dinâmicas | Usuários do Mongo e do RabbitMQ | O Agent renova a lease. No fim do TTL máximo, grava credenciais novas; a API percebe em até `SECRETS_RELOAD_INTERVAL_MS` e reconecta, sem reiniciar |
| Certificado da API | `api-cert`, `api-key` | `pkiCert` renova antes de vencer; o servidor HTTPS e as conexões mTLS são refeitos sozinhos |
| Segredos estáticos | Senha do Redis, token do InfluxDB, senha do admin, chaves dos JWTs | Relidos a cada 5 min pelo Agent. A troca das chaves dos JWTs exige um rollout, porque o `kid` muda e o Kong precisa da nova chave pública |
| MFA | Nenhum arquivo | O Transit é chamado pelo proxy do Agent no próprio pod (`VAULT_ADDR=http://127.0.0.1:8200`) |

**Sem Vault** (`vault.enabled=false`): crie um Secret com os mesmos nomes de arquivo, por exemplo via Vault Secrets Operator ou External Secrets, e informe em `secrets.existingSecret`. Inclua `mfa-encryption-key`, porque o MFA passa a usar a cifra local.

## Saúde e encerramento

- **Porta da API:** com `SERVER_TLS_CLIENT_AUTH=require`, só aceita o Kong.
- **Probes:** usam a porta `health` (8081, HTTP, só `/health*`). O kubelet não apresenta certificado de cliente.
- **Liveness:** `/health/live`, sem dependências.
- **Readiness:** `/health/ready`, que tira o pod do balanceamento quando o Mongo ou o Redis caem.
- **Encerramento:**
  1. o `preStop` (5 s) dá tempo para os Endpoints e o Kong pararem de enviar tráfego;
  2. o `SIGTERM` encerra de forma graciosa (`terminationGracePeriodSeconds: 35`).

## Migração de índices

O job `<release>-migrate` (hook `pre-install,pre-upgrade`) roda `node src/main/migrate.ts`:
- **O que faz:** cria os índices que faltam; remove os obsoletos só com `migrations.dropObsoleteIndexes=true`.
- **Efeito:** as réplicas sobem com `MONGO_AUTO_INDEX=false` e não disputam a criação de índices.
- **Se falhar:** a atualização para (`helm upgrade --wait` falha).

## Valores principais

| Valor | Padrão | Descrição |
|---|---|---|
| `image.repository` / `image.tag` | — / `appVersion` | Imagem; no CD, a tag é o commit |
| `config.*` | ver `values.yaml` | Variáveis não secretas da API (drivers, endereços, `MFA_REQUIRED_ROLES`...) |
| `server.tls.enabled` / `clientAuth` | `true` / `require` | HTTPS na API; `require` aceita só o Kong |
| `vault.enabled` / `role` / `secrets` / `transit` | `true` / `api` / todos / `true` | Agent Injector, papel, arquivos entregues, MFA pelo Transit |
| `vault.apiCert.ttl` / `altNames` | `72h` / `[]` | Validade e nomes extras do certificado da API |
| `secrets.existingSecret` | — | Alternativa ao Vault |
| `migrations.enabled` | `true` | Job de índices |
| `autoscaling.*` / `podDisruptionBudget.*` | 2 a 6 réplicas, CPU 70% / `minAvailable: 1` | |
| `networkPolicy.*` | ligado | Só o namespace do Kong alcança a API; só o do monitoramento, as métricas |
| `kong.host` / `kong.tls.secretName` | — | Host público e certificado |
| `kong.jwt.publicKey` | — (**obrigatório**) | `vault kv get -field=public_key kv/api/jwt` |
| `kong.rateLimit.policy` / `redis.*` | `redis` | Contagem compartilhada entre réplicas do Kong |
| `kong.routes` | as mesmas do `kong.template.yml` | Caminhos, métodos, JWT e limites por rota |
| `metrics.serviceMonitor.enabled` / `prometheusRule.enabled` | `false` | Prometheus Operator |
| `metrics.prometheusRule.slo.*` | 99,5% / 500 ms / 95% | Objetivos usados nos alertas |

## Testes do chart

- **`npm test`:** inclui [`test/unit/helm.test.ts`](../../../test/unit/helm.test.ts), que renderiza o chart com os valores de `ci/` e valida o `env` gerado com o próprio `loadEnv` da API. Ele também confere se cada arquivo esperado tem um template do Agent.
- **No CI:** `helm lint`, `helm template` e `kubeconform`, com os schemas das CRDs do Kong e do Prometheus Operator.
