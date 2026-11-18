# Usuários temporários do MongoDB: cada instância da API recebe o seu, que expira e é revogado sozinho.

locals {
  # ambiente local: o Vault usa o certificado "vault" emitido em local.tf (o Mongo exige certificado de cliente)
  local_vault_cert = try(vault_pki_secret_backend_cert.local["vault"], null)
  mongodb_tls_ca = var.mongodb == null ? null : (
    var.mongodb.tls_ca != null ? var.mongodb.tls_ca :
    local.local_vault_cert != null ? vault_pki_secret_backend_root_cert.root.certificate : null
  )
  mongodb_tls_cert_key = var.mongodb == null ? null : (
    var.mongodb.tls_cert_key != null ? var.mongodb.tls_cert_key :
    local.local_vault_cert != null ? join("\n", [
      local.local_vault_cert.certificate, local.local_vault_cert.issuing_ca, local.local_vault_cert.private_key,
    ]) : null
  )
}
resource "vault_mount" "database" {
  count       = var.mongodb == null ? 0 : 1
  path        = local.mounts.database
  type        = "database"
  description = "Credenciais dinâmicas de banco (${var.environment})"
}

resource "vault_database_secret_backend_connection" "mongodb" {
  count         = var.mongodb == null ? 0 : 1
  backend       = vault_mount.database[0].path
  name          = "mongodb"
  allowed_roles = [local.role]
  # o Mongo pode ainda não estar no ar na primeira aplicação (ambiente local): a conexão é testada no primeiro uso
  verify_connection = false

  mongodb {
    connection_url = var.mongodb.connection_url
    username       = var.mongodb.username
    password       = var.mongodb_password
    # o Vault fala com o Mongo por TLS, com a CA e o próprio certificado (mTLS)
    tls_ca              = local.mongodb_tls_ca
    tls_certificate_key = local.mongodb_tls_cert_key
  }
}

resource "vault_database_secret_backend_role" "api" {
  count       = var.mongodb == null ? 0 : 1
  backend     = vault_mount.database[0].path
  name        = local.role
  db_name     = vault_database_secret_backend_connection.mongodb[0].name
  default_ttl = var.mongodb.default_ttl
  max_ttl     = var.mongodb.max_ttl
  creation_statements = [jsonencode({
    db    = "admin"
    roles = [for role in var.mongodb.roles : role.db == null ? { role = role.role } : { role = role.role, db = role.db }]
  })]
}
