# Segredos estáticos (KV v2): <kv>/api/static e <kv>/api/jwt. Versionados pelo próprio Vault.
resource "vault_mount" "kv" {
  path        = local.mounts.kv
  type        = "kv"
  options     = { version = "2" }
  description = "Segredos estáticos (${var.environment})"
}

# Par de chaves dos JWTs: a privada só a API lê; a pública vai também para o Kong.
resource "tls_private_key" "jwt" {
  count     = var.generate_jwt_keys ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 3072
}

resource "vault_kv_secret_v2" "jwt" {
  count = var.generate_jwt_keys ? 1 : 0
  mount = vault_mount.kv.path
  name  = "${local.role}/jwt"
  data_json = jsonencode({
    private_key = tls_private_key.jwt[0].private_key_pem_pkcs8
    public_key  = tls_private_key.jwt[0].public_key_pem
  })
}

# Só no ambiente local: em produção os valores são gravados direto no Vault, fora do código e do estado.
resource "vault_kv_secret_v2" "static" {
  count     = var.static_secrets == null ? 0 : 1
  mount     = vault_mount.kv.path
  name      = "${local.role}/static"
  data_json = jsonencode({ for key, value in var.static_secrets : key => value if value != null })
}
