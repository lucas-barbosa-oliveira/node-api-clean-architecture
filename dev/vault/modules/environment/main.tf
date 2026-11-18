# Um ambiente (local, dev, hml, prd) dentro de um Vault: motores com o prefixo do ambiente e a autenticação do
# cluster dele. Credenciais de um ambiente nunca abrem recursos de outro.
#
#   <env>/kv        segredos estáticos (KV v2)        <env>/database  usuários temporários do MongoDB
#   <env>/pki       CA intermediária do ambiente      <env>/rabbitmq  usuários temporários do RabbitMQ
#   <env>/transit   cifra como serviço                auth k8s-<env>  pods do cluster do ambiente
terraform {
  required_providers {
    vault = { source = "hashicorp/vault", version = ">= 4.8.0, < 6.0.0" }
  }
}

variable "name" {
  description = "Nome do ambiente: prefixo dos motores (local, dev, hml, prd)."
  type        = string
}

variable "root_pki_mount" {
  description = "Mount da CA raiz (módulo root-pki), que assina a intermediária do ambiente."
  type        = string
}

variable "pki" {
  type = object({
    organization    = string
    infra_domains   = list(string) # serviços da plataforma: bancos, broker, Kong
    allow_ip_sans   = optional(bool, false)
    allow_localhost = optional(bool, false)
    int_ttl         = optional(string, "43800h")
    leaf_ttl        = optional(string, "72h")
    leaf_max_ttl    = optional(string, "720h")
    key_type        = optional(string, "ec")
    key_bits        = optional(number, 256)
  })
}

variable "mongodb" {
  description = "Conexão de administração do MongoDB para usuários temporários. null desliga."
  type = object({
    connection_url = string # mongodb://{{username}}:{{password}}@host:27017/admin?tls=true
    username       = string
    tls_ca         = optional(string)
    # Certificado de cliente do Vault (mTLS). ATENÇÃO: com ele, o plugin do Vault autentica por X.509 (não por
    # usuário e senha): exige no Mongo um usuário em $external com o subject do certificado (ex.: CN=vault,O=<org>).
    tls_cert_key = optional(string)
    # o próprio módulo emite esse certificado pela PKI do ambiente (papel infra), com este nome (mesma regra do X.509)
    issue_vault_client_cert = optional(string)
  })
  default = null
}

variable "mongodb_password" {
  type      = string
  default   = null
  sensitive = true
}

variable "rabbitmq" {
  description = "API de administração do RabbitMQ para usuários temporários. null desliga."
  type = object({
    connection_uri = string
    username       = string
    default_ttl    = optional(number, 3600)
    max_ttl        = optional(number, 86400)
  })
  default = null
}

variable "rabbitmq_password" {
  type      = string
  default   = null
  sensitive = true
}

variable "kubernetes" {
  description = "Cluster do ambiente (Kubernetes auth). null desliga."
  type = object({
    host    = string # API do cluster vista pelo Vault
    ca_cert = optional(string)
    # Vault fora do cluster: JWT de uma ServiceAccount com system:auth-delegator, para validar os tokens dos pods
    token_reviewer_jwt = optional(string)
  })
  default = null
}

variable "approle" {
  description = "AppRole (Vault Agent fora do Kubernetes, ex.: ambiente local)."
  type        = bool
  default     = false
}

locals {
  prefix = var.name
}

resource "vault_mount" "kv" {
  path        = "${local.prefix}/kv"
  type        = "kv"
  options     = { version = "2" }
  description = "Segredos estáticos (${var.name})"
}

# ---------- PKI intermediária ----------
resource "vault_mount" "pki" {
  path                  = "${local.prefix}/pki"
  type                  = "pki"
  max_lease_ttl_seconds = 157680000
  description           = "CA intermediária (${var.name})"
}

resource "vault_pki_secret_backend_intermediate_cert_request" "int" {
  backend      = vault_mount.pki.path
  type         = "internal"
  common_name  = "${var.pki.organization} ${var.name} Intermediate CA"
  organization = var.pki.organization
  key_type     = var.pki.key_type
  key_bits     = var.pki.key_bits
}

resource "vault_pki_secret_backend_root_sign_intermediate" "int" {
  backend         = var.root_pki_mount
  csr             = vault_pki_secret_backend_intermediate_cert_request.int.csr
  common_name     = "${var.pki.organization} ${var.name} Intermediate CA"
  ttl             = var.pki.int_ttl
  max_path_length = 0
}

resource "vault_pki_secret_backend_intermediate_set_signed" "int" {
  backend     = vault_mount.pki.path
  certificate = vault_pki_secret_backend_root_sign_intermediate.int.certificate
}

# serviços da plataforma (bancos, broker, Kong), emitidos pelo cert-manager com emissor Vault
resource "vault_pki_secret_backend_role" "infra" {
  backend            = vault_mount.pki.path
  name               = "infra"
  allowed_domains    = var.pki.infra_domains
  allow_bare_domains = true
  allow_subdomains   = false
  allow_localhost    = var.pki.allow_localhost
  allow_ip_sans      = var.pki.allow_ip_sans
  server_flag        = true
  client_flag        = true
  key_type           = var.pki.key_type
  key_bits           = var.pki.key_bits
  ttl                = var.pki.leaf_ttl
  max_ttl            = var.pki.leaf_max_ttl
  organization       = [var.pki.organization]
  depends_on         = [vault_pki_secret_backend_intermediate_set_signed.int]
}

# ---------- credenciais dinâmicas ----------
resource "vault_mount" "database" {
  count       = var.mongodb == null ? 0 : 1
  path        = "${local.prefix}/database"
  type        = "database"
  description = "Credenciais dinâmicas de banco (${var.name})"
}

resource "vault_pki_secret_backend_cert" "vault_client" {
  count       = try(var.mongodb.issue_vault_client_cert, null) == null ? 0 : 1
  backend     = vault_mount.pki.path
  name        = vault_pki_secret_backend_role.infra.name
  common_name = var.mongodb.issue_vault_client_cert
  ttl         = var.pki.leaf_max_ttl
  auto_renew  = true
}

locals {
  mongodb_tls_cert_key = var.mongodb == null ? null : (
    var.mongodb.tls_cert_key != null ? var.mongodb.tls_cert_key :
    length(vault_pki_secret_backend_cert.vault_client) > 0 ? join("\n", [
      vault_pki_secret_backend_cert.vault_client[0].certificate,
      vault_pki_secret_backend_cert.vault_client[0].issuing_ca,
      vault_pki_secret_backend_cert.vault_client[0].private_key,
    ]) : null
  )
}

resource "vault_database_secret_backend_connection" "mongodb" {
  count             = var.mongodb == null ? 0 : 1
  backend           = vault_mount.database[0].path
  name              = "mongodb"
  allowed_roles     = ["*"] # cada serviço cria o seu papel (módulo service)
  verify_connection = false

  mongodb {
    connection_url      = var.mongodb.connection_url
    username            = var.mongodb.username
    password            = var.mongodb_password
    tls_ca              = var.mongodb.tls_ca
    tls_certificate_key = local.mongodb_tls_cert_key
  }
}

resource "vault_rabbitmq_secret_backend" "rabbitmq" {
  count                     = var.rabbitmq == null ? 0 : 1
  path                      = "${local.prefix}/rabbitmq"
  connection_uri            = var.rabbitmq.connection_uri
  username                  = var.rabbitmq.username
  password                  = var.rabbitmq_password
  verify_connection         = false
  default_lease_ttl_seconds = var.rabbitmq.default_ttl
  max_lease_ttl_seconds     = var.rabbitmq.max_ttl
  description               = "Credenciais dinâmicas do RabbitMQ (${var.name})"
}

resource "vault_mount" "transit" {
  path        = "${local.prefix}/transit"
  type        = "transit"
  description = "Cifra como serviço (${var.name})"
}

# ---------- autenticação ----------
resource "vault_auth_backend" "kubernetes" {
  count = var.kubernetes == null ? 0 : 1
  type  = "kubernetes"
  path  = "k8s-${var.name}"
}

resource "vault_kubernetes_auth_backend_config" "kubernetes" {
  count              = var.kubernetes == null ? 0 : 1
  backend            = vault_auth_backend.kubernetes[0].path
  kubernetes_host    = var.kubernetes.host
  kubernetes_ca_cert = var.kubernetes.ca_cert
  token_reviewer_jwt = var.kubernetes.token_reviewer_jwt
}

resource "vault_auth_backend" "approle" {
  count = var.approle ? 1 : 0
  type  = "approle"
  path  = "approle-${var.name}"
}

output "env" {
  description = "Tudo que o módulo service precisa saber do ambiente."
  value = {
    name = var.name
    mounts = {
      kv       = vault_mount.kv.path
      pki      = vault_mount.pki.path
      root_pki = var.root_pki_mount
      database = var.mongodb == null ? null : vault_mount.database[0].path
      rabbitmq = var.rabbitmq == null ? null : vault_rabbitmq_secret_backend.rabbitmq[0].path
      transit  = vault_mount.transit.path
    }
    auth = {
      kubernetes = var.kubernetes == null ? null : vault_auth_backend.kubernetes[0].path
      approle    = var.approle ? vault_auth_backend.approle[0].path : null
    }
    pki = var.pki
  }
  depends_on = [vault_pki_secret_backend_intermediate_set_signed.int]
}

output "infra_role" {
  value = vault_pki_secret_backend_role.infra.name
}
