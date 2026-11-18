# Vault local de desenvolvimento (docker-compose.vault.yml), aplicado por npm run vault:bootstrap.
# Valores de desenvolvimento, sem segredos reais. Os caminhos são relativos a infra/vault.
environment = "local"

pki = {
  api_domains     = ["api", "localhost", "host.docker.internal"]
  infra_domains   = ["mongo", "redis", "rabbitmq", "influxdb", "kong", "vault", "localhost"]
  allow_ip_sans   = true
  allow_localhost = true
  leaf_ttl        = "24h"
}

# O Vault (em container) cria usuários temporários no Mongo com este administrador (criado pelo healthcheck do mongo
# no docker-compose.vault.yml). Local: papéis amplos, para os testes criarem e apagarem bancos próprios.
mongodb = {
  connection_url = "mongodb://{{username}}:{{password}}@mongo:27017/admin?directConnection=true&tls=true"
  username       = "vault-admin"
  roles = [
    { role = "readWriteAnyDatabase" },
    { role = "dbAdminAnyDatabase" },
    { role = "clusterMonitor" },
  ]
  default_ttl = 3600
  max_ttl     = 86400
}
mongodb_password = "vault-admin-local"

# API de administração em HTTP só na rede interna do compose (o Vault local não tem a CA do RabbitMQ)
rabbitmq = {
  connection_uri = "http://rabbitmq:15672"
  username       = "app"
}
rabbitmq_password = "app-rabbit-local"

static_secrets = {
  influx_token   = "dev-influx-token-local"
  admin_password = "admin-local-123"
  redis_password = "redis-local-pass"
}

approle = {
  output_dir = "../../.vault/approle"
}

jwt_public_key_file = "../../.vault/jwt.public.pem"

local_certs = {
  output_dir = "../../certs"
  services = {
    mongo    = ["mongo", "localhost", "127.0.0.1"]
    redis    = ["redis", "localhost", "127.0.0.1"]
    rabbitmq = ["rabbitmq", "localhost", "127.0.0.1"]
    influxdb = ["influxdb", "localhost", "127.0.0.1"]
    kong     = ["kong", "localhost", "127.0.0.1"]
    vault    = ["vault", "localhost"] # certificado de cliente do Vault para o Mongo (mTLS)
  }
}

audit_file_path = "stdout"
