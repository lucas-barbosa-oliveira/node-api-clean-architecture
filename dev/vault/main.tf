# Vault LOCAL de desenvolvimento (docker-compose.vault.yml), aplicado por npm run docker:up:vault num Vault em modo
# dev recriado a cada subida. Usa os mesmos módulos da plataforma (copiados em ./modules) com o ambiente "local":
# os caminhos são os mesmos do Kubernetes, só muda o prefixo (local/... em vez de dev/..., hml/..., prd/...).
# Valores locais, sem segredos reais. Caminhos de arquivos relativos a dev/vault.
terraform {
  required_version = ">= 1.8.0"
  required_providers {
    vault = { source = "hashicorp/vault", version = ">= 4.8.0, < 6.0.0" }
    local = { source = "hashicorp/local", version = "~> 2.5" }
    tls   = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}

provider "vault" {}

locals {
  project   = "matrixgrid"
  service   = "api-clean-architecture"
  out       = "${path.module}/../.."
  infra_svc = ["mongo", "redis", "rabbitmq", "influxdb", "kong"]
}

module "root_pki" {
  source       = "./modules/root-pki"
  common_name  = "matrixgrid local Root CA"
  organization = "matrixgrid"
}

module "environment" {
  source         = "./modules/environment"
  name           = "local"
  root_pki_mount = module.root_pki.mount_path
  approle        = true
  pki = {
    organization    = "matrixgrid"
    infra_domains   = concat(local.infra_svc, ["localhost"])
    allow_ip_sans   = true
    allow_localhost = true
    leaf_ttl        = "24h"
  }
  # o healthcheck do mongo (infra/local/mongo/healthcheck.js) cria este administrador
  mongodb = {
    connection_url = "mongodb://{{username}}:{{password}}@mongo:27017/admin?directConnection=true&tls=true"
    username       = "vault-admin"
    tls_ca         = module.root_pki.certificate
    # TLS verificando a CA, com usuário e senha (sem certificado de cliente: com ele, o plugin usaria X.509)
  }
  mongodb_password = "vault-admin-local"
  # administração em HTTP só na rede interna do compose (rabbitmq/30-vault.conf)
  rabbitmq = {
    connection_uri = "http://rabbitmq:15672"
    username       = "app"
  }
  rabbitmq_password = "app-rabbit-local"
}

module "service" {
  source             = "./modules/service"
  env                = module.environment.env
  project            = local.project
  name               = local.service
  approle_output_dir = "${local.out}/.vault/approle"
  mongodb = {
    # local: papéis amplos, para os testes criarem e apagarem bancos próprios
    roles = [{ role = "readWriteAnyDatabase" }, { role = "dbAdminAnyDatabase" }, { role = "clusterMonitor" }]
  }
  rabbitmq = { vhost = "/" }
  transit  = {}
  certificate = {
    names         = ["api", "localhost", "host.docker.internal"]
    allow_ip_sans = true
    localhost     = true
    ttl           = "24h"
  }
  generate_jwt_keys   = true
  jwt_public_key_file = "${local.out}/.vault/jwt.public.pem"
  static_secrets = {
    influx_token   = "dev-influx-token-local"
    admin_password = "admin-local-123"
    redis_password = "redis-local-pass"
  }
}

# ---------- certificados dos serviços de infraestrutura (certs/, mesmos nomes do npm run tls:setup) ----------
resource "vault_pki_secret_backend_cert" "infra" {
  for_each    = toset(local.infra_svc)
  backend     = module.environment.env.mounts.pki
  name        = module.environment.infra_role
  common_name = each.key
  alt_names   = ["localhost"]
  ip_sans     = ["127.0.0.1"]
  ttl         = "720h"
  auto_renew  = true
}

resource "local_file" "ca" {
  filename        = "${local.out}/certs/ca.crt"
  content         = module.root_pki.certificate
  file_permission = "0644"
}

resource "local_file" "cert" {
  for_each        = vault_pki_secret_backend_cert.infra
  filename        = "${local.out}/certs/${each.key}.crt"
  content         = "${each.value.certificate}\n${each.value.issuing_ca}\n"
  file_permission = "0644"
}

resource "local_sensitive_file" "key" {
  for_each        = vault_pki_secret_backend_cert.infra
  filename        = "${local.out}/certs/${each.key}.key"
  content         = each.value.private_key
  file_permission = "0644" # cada container roda com um uid diferente; só local
}

resource "local_sensitive_file" "mongo_pem" {
  filename        = "${local.out}/certs/mongo.pem"
  content         = "${vault_pki_secret_backend_cert.infra["mongo"].certificate}\n${vault_pki_secret_backend_cert.infra["mongo"].issuing_ca}\n${vault_pki_secret_backend_cert.infra["mongo"].private_key}\n"
  file_permission = "0644"
}

resource "vault_audit" "stdout" {
  type    = "file"
  options = { file_path = "stdout" }
}
