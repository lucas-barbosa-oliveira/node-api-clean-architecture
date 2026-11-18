# Módulo OpenTofu do Vault

Configuração do Vault (ou OpenBao) de que a API precisa, como código. O mesmo módulo é aplicado:

- **no ambiente local**, por `npm run docker:up:vault`, com [`envs/local.tfvars`](envs/local.tfvars), num Vault em modo dev recriado a cada subida;
- **nos ambientes do Kubernetes**, pelo pipeline da plataforma, com as variáveis do ambiente (exemplo em [`envs/production.tfvars.example`](envs/production.tfvars.example)).

Requer OpenTofu ≥ 1.8 e um token com permissão de administração no Vault (`VAULT_ADDR` e `VAULT_TOKEN` no ambiente). O provider `hashicorp/vault` também funciona com o OpenBao.

## O que é criado

| Recurso | Caminho | Para quê |
|---|---|---|
| KV v2 | `kv/api/static`, `kv/api/jwt` | Segredos estáticos (token do InfluxDB, senha do admin, senha do Redis) e o par de chaves dos JWTs |
| PKI raiz | `pki/` | CA raiz; a chave nunca sai do Vault e só assina a intermediária |
| PKI intermediária | `pki_int/`, papéis `api` e `infra` | Certificados da API (servidor e cliente mTLS) e dos serviços de infraestrutura e do Kong |
| Database | `database/creds/api` | Usuário temporário do MongoDB por instância (TTL 1 h, máximo 24 h) |
| RabbitMQ | `rabbitmq/creds/api` | Usuário temporário do RabbitMQ, só no vhost do serviço |
| Transit | `transit/keys/mfa` | Cifra dos segredos TOTP do MFA; rotação automática (30 dias) |
| Política | `api-clean-architecture` | Só leitura dos próprios segredos e uso dos próprios papéis ([`policies/api.hcl.tftpl`](policies/api.hcl.tftpl)) |
| Kubernetes auth | `auth/kubernetes/role/api` | O pod se autentica com o token da ServiceAccount (`api-clean-architecture` e `api-clean-architecture-migrate`) |
| AppRole | `auth/approle/role/api` | Só local: o Vault Agent em container (role-id e secret-id gravados em `.vault/approle`) |
| Auditoria | dispositivo `file` | Quem leu o quê (valores em hash) |

## Variáveis principais

| Variável | Uso |
|---|---|
| `environment` | Nome do ambiente |
| `pki` | Nomes aceitos nos certificados (`api_domains`, `infra_domains`), validades e tipo de chave |
| `mongodb` + `mongodb_password` | Conexão de administração para os usuários temporários; `null` desliga |
| `rabbitmq` + `rabbitmq_password` | API de administração para os usuários temporários; `null` desliga |
| `kubernetes` | Endereço da API do cluster, namespaces e ServiceAccounts permitidas |
| `static_secrets` | **Só local.** Em produção, `null`: grave os valores com `vault kv put kv/api/static ...` |
| `generate_jwt_keys` | Gera o par dos JWTs (fica no estado: use estado cifrado) |
| `local_certs`, `approle`, `jwt_public_key_file` | Só local: certificados dos serviços em `certs/`, credenciais do Agent e chave pública para o `kong:setup` |
| `audit_file_path` | Auditoria em arquivo (`stdout` no local) |

As senhas de administração vêm de `TF_VAR_mongodb_password` e `TF_VAR_rabbitmq_password` no pipeline, nunca do arquivo de variáveis.

## Aplicar em um ambiente

```bash
export VAULT_ADDR=https://vault.exemplo.com VAULT_TOKEN=...       # token de administração (do pipeline)
export TF_VAR_mongodb_password=... TF_VAR_rabbitmq_password=...
export TF_ENCRYPTION="$(cat envs/encryption.example.hcl)"        # adapte: chave no KMS
tofu init -backend-config=...                                     # backend remoto do estado (S3, GCS, etc.)
tofu plan  -var-file=envs/production.tfvars
tofu apply -var-file=envs/production.tfvars

# segredos estáticos, fora do código e do estado
vault kv put kv/api/static influx_token=... admin_password=... redis_password=...
```

**Estado cifrado.** O estado deste módulo tem dados sensíveis: a chave dos JWTs, quando gerada aqui, e a senha de administração dos bancos. Use a cifra de estado do OpenTofu (`TF_ENCRYPTION`, com chave no KMS) e um backend remoto com acesso restrito. Ou use `generate_jwt_keys = false` e grave a chave com `vault kv put`.

**CA raiz fora do Vault.** Se a política da empresa exigir uma raiz corporativa, troque `vault_pki_secret_backend_root_sign_intermediate` pela assinatura externa do CSR (`vault_pki_secret_backend_intermediate_cert_request.int.csr`) e importe o certificado assinado.

## Contrato com a API

Os templates do Vault Agent ([`deploy/helm/api-clean-architecture/files/vault`](../../deploy/helm/api-clean-architecture/files/vault)) dependem dos caminhos padrão dos motores (`kv`, `pki`, `pki_int`, `database`, `rabbitmq`, `transit`) e do papel `api`. Se mudar `var.mounts`, mude os templates junto.
