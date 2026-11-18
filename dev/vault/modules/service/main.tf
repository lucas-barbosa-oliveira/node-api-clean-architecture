# O que um serviço de um projeto recebe num ambiente: política mínima, papel de autenticação, usuário temporário no
# banco e no broker, certificado próprio, chave do Transit e segredos estáticos. Nome do papel: <projeto>-<serviço>.
#
# Caminhos (usados pelos templates do Vault Agent nos values do serviço, com @@VAULT_ENV@@ e @@VAULT_ROLE@@):
#   <env>/kv/data/<projeto>/<serviço>/static | jwt      <env>/database/creds/<papel>   <env>/rabbitmq/creds/<papel>
#   <env>/pki/issue/<papel>                              pki-root/cert/ca              <env>/transit (chave <papel>)
terraform {
  required_providers {
    vault = { source = "hashicorp/vault", version = ">= 4.8.0, < 6.0.0" }
    local = { source = "hashicorp/local", version = "~> 2.5" }
    tls   = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}

variable "env" {
  description = "Saída env do módulo environment."
  type = object({
    name   = string
    mounts = object({ kv = string, pki = string, root_pki = string, database = string, rabbitmq = string, transit = string })
    auth   = object({ kubernetes = string, approle = string })
    pki = object({
      organization = string, infra_domains = list(string), allow_ip_sans = bool, allow_localhost = bool,
      int_ttl      = string, leaf_ttl = string, leaf_max_ttl = string, key_type = string, key_bits = number,
    })
  })
}

variable "project" {
  type = string
}

variable "name" {
  type = string
}

variable "kubernetes" {
  description = "Namespace e ServiceAccounts do serviço (inclui a do job de migração)."
  type = object({
    namespace        = string
    service_accounts = list(string)
    audience         = optional(string)
    token_ttl        = optional(number, 3600)
  })
  default = null
}

variable "approle_output_dir" {
  description = "Só local: grava role-id e secret-id do AppRole neste diretório (lidos pelo Vault Agent em container)."
  type        = string
  default     = null
}

variable "mongodb" {
  type = object({
    roles       = list(object({ role = string, db = optional(string) }))
    default_ttl = optional(number, 3600)
    max_ttl     = optional(number, 86400)
  })
  default = null
}

variable "rabbitmq" {
  type = object({
    vhost     = optional(string, "/")
    configure = optional(string, ".*")
    write     = optional(string, ".*")
    read      = optional(string, ".*")
    tags      = optional(string, "")
  })
  default = null
}

variable "transit" {
  type    = object({ auto_rotate_period = optional(number, 2592000) })
  default = null
}

variable "certificate" {
  description = "Nomes aceitos no certificado do serviço (servidor e cliente mTLS)."
  type = object({
    names         = list(string)
    allow_ip_sans = optional(bool, false)
    localhost     = optional(bool, false)
    ttl           = optional(string, "72h")
    max_ttl       = optional(string, "720h")
  })
  default = null
}

variable "generate_jwt_keys" {
  description = "Gera o par RSA dos JWTs em <env>/kv/<projeto>/<serviço>/jwt (fica no estado: use estado cifrado)."
  type        = bool
  default     = false
}

variable "jwt_public_key_file" {
  description = "Só local: grava a chave pública dos JWTs neste arquivo (lido pelo kong:setup)."
  type        = string
  default     = null
}

variable "static_secrets" {
  description = "Só local: segredos estáticos de desenvolvimento. Em ambientes reais, null e vault kv put."
  type        = map(string)
  default     = null
  sensitive   = true
}

locals {
  role    = "${var.project}-${var.name}"
  kv_path = "${var.project}/${var.name}"
}

resource "vault_policy" "service" {
  name = "${var.env.name}-${local.role}"
  policy = templatefile("${path.module}/policies/service.hcl.tftpl", {
    kv       = var.env.mounts.kv
    kv_path  = local.kv_path
    pki      = var.env.mounts.pki
    root_pki = var.env.mounts.root_pki
    database = var.mongodb == null ? null : var.env.mounts.database
    rabbitmq = var.rabbitmq == null ? null : var.env.mounts.rabbitmq
    transit  = var.transit == null ? null : var.env.mounts.transit
    role     = local.role
  })
}

# ---------- autenticação ----------
resource "vault_kubernetes_auth_backend_role" "service" {
  count                            = var.kubernetes == null ? 0 : 1
  backend                          = var.env.auth.kubernetes
  role_name                        = local.role
  bound_service_account_names      = var.kubernetes.service_accounts
  bound_service_account_namespaces = [var.kubernetes.namespace]
  audience                         = var.kubernetes.audience
  token_policies                   = [vault_policy.service.name]
  token_ttl                        = var.kubernetes.token_ttl
}

resource "vault_approle_auth_backend_role" "service" {
  count          = var.approle_output_dir == null ? 0 : 1
  backend        = var.env.auth.approle
  role_name      = local.role
  token_policies = [vault_policy.service.name]
  token_ttl      = 3600
  token_max_ttl  = 86400
}

resource "vault_approle_auth_backend_role_secret_id" "service" {
  count     = var.approle_output_dir == null ? 0 : 1
  backend   = var.env.auth.approle
  role_name = vault_approle_auth_backend_role.service[0].role_name
}

resource "local_file" "role_id" {
  count           = var.approle_output_dir == null ? 0 : 1
  filename        = "${var.approle_output_dir}/role-id"
  content         = vault_approle_auth_backend_role.service[0].role_id
  file_permission = "0644"
}

resource "local_sensitive_file" "secret_id" {
  count           = var.approle_output_dir == null ? 0 : 1
  filename        = "${var.approle_output_dir}/secret-id"
  content         = vault_approle_auth_backend_role_secret_id.service[0].secret_id
  file_permission = "0644" # lido pelo Agent em container (outro uid); só local
}

# ---------- credenciais dinâmicas ----------
resource "vault_database_secret_backend_role" "service" {
  count       = var.mongodb == null ? 0 : 1
  backend     = var.env.mounts.database
  name        = local.role
  db_name     = "mongodb"
  default_ttl = var.mongodb.default_ttl
  max_ttl     = var.mongodb.max_ttl
  creation_statements = [jsonencode({
    db    = "admin"
    roles = [for r in var.mongodb.roles : r.db == null ? { role = r.role } : { role = r.role, db = r.db }]
  })]
}

resource "vault_rabbitmq_secret_backend_role" "service" {
  count   = var.rabbitmq == null ? 0 : 1
  backend = var.env.mounts.rabbitmq
  name    = local.role
  tags    = var.rabbitmq.tags

  vhost {
    host      = var.rabbitmq.vhost
    configure = var.rabbitmq.configure
    write     = var.rabbitmq.write
    read      = var.rabbitmq.read
  }
}

# ---------- certificado e cifra ----------
resource "vault_pki_secret_backend_role" "service" {
  count              = var.certificate == null ? 0 : 1
  backend            = var.env.mounts.pki
  name               = local.role
  allowed_domains    = var.certificate.names
  allow_bare_domains = true
  allow_subdomains   = false
  allow_localhost    = var.certificate.localhost
  allow_ip_sans      = var.certificate.allow_ip_sans
  server_flag        = true
  client_flag        = true
  key_type           = var.env.pki.key_type
  key_bits           = var.env.pki.key_bits
  ttl                = var.certificate.ttl
  max_ttl            = var.certificate.max_ttl
  organization       = [var.env.pki.organization]
}

resource "vault_transit_secret_backend_key" "service" {
  count              = var.transit == null ? 0 : 1
  backend            = var.env.mounts.transit
  name               = local.role
  type               = "aes256-gcm96"
  deletion_allowed   = false
  exportable         = false
  auto_rotate_period = var.transit.auto_rotate_period
}

# ---------- segredos estáticos ----------
resource "tls_private_key" "jwt" {
  count     = var.generate_jwt_keys ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 3072
}

resource "vault_kv_secret_v2" "jwt" {
  count = var.generate_jwt_keys ? 1 : 0
  mount = var.env.mounts.kv
  name  = "${local.kv_path}/jwt"
  data_json = jsonencode({
    private_key = tls_private_key.jwt[0].private_key_pem_pkcs8
    public_key  = tls_private_key.jwt[0].public_key_pem
  })
}

resource "local_file" "jwt_public_key" {
  count           = var.generate_jwt_keys && var.jwt_public_key_file != null ? 1 : 0
  filename        = var.jwt_public_key_file
  content         = tls_private_key.jwt[0].public_key_pem
  file_permission = "0644"
}

resource "vault_kv_secret_v2" "static" {
  count     = var.static_secrets == null ? 0 : 1
  mount     = var.env.mounts.kv
  name      = "${local.kv_path}/static"
  data_json = jsonencode(var.static_secrets)
}

output "role" {
  value = local.role
}

output "policy" {
  value = vault_policy.service.name
}

output "jwt_public_key_pem" {
  value = var.generate_jwt_keys ? tls_private_key.jwt[0].public_key_pem : null
}
