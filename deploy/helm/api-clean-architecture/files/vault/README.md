# Templates do Vault Agent

Fonte única dos arquivos que o Vault Agent entrega à API. O chart Helm (anotações do Agent Injector) e o ambiente
local (`scripts/vault.local.ts`, container `vault-agent`) usam estes arquivos.

| Arquivo entregue | Origem no Vault | Variável da API |
|---|---|---|
| `mongo-username`, `mongo-password` | `database/creds/api` (usuário temporário) | `MONGO_USERNAME_FILE`, `MONGO_PASSWORD_FILE` |
| `rabbitmq-username`, `rabbitmq-password` | `rabbitmq/creds/api` (usuário temporário) | `RABBITMQ_USERNAME_FILE`, `RABBITMQ_PASSWORD_FILE` |
| `redis-password`, `influx-token`, `admin-password` | `kv/api/static` | `REDIS_PASSWORD_FILE`, `INFLUX_TOKEN_FILE`, `ADMIN_PASSWORD_FILE` |
| `jwt-private-key`, `jwt-public-key` | `kv/api/jwt` | `JWT_PRIVATE_KEY_PATH`, `JWT_PUBLIC_KEY_PATH` |
| `ca-cert` | `pki/cert/ca` (raiz) | `TLS_CA_FILE`, `SERVER_TLS_CA_FILE` |
| `api-cert`, `api-key` | `pki_int/issue/api` | `SERVER_TLS_CERT_FILE`/`KEY_FILE`, `TLS_CLIENT_CERT_FILE`/`KEY_FILE` |

Os caminhos dos motores (`database`, `rabbitmq`, `kv`, `pki`, `pki_int`) são os padrões do módulo `infra/vault`:
mudou lá, mude aqui. Os marcadores `@@...@@` do `api-cert.ctmpl` são preenchidos por quem usa o template.
