# Cifra dos segredos TOTP do MFA: a chave nunca sai do Vault (MFA_CIPHER=vault-transit na API).
resource "vault_mount" "transit" {
  path        = local.mounts.transit
  type        = "transit"
  description = "Cifra como serviço (${var.environment})"
}

resource "vault_transit_secret_backend_key" "mfa" {
  backend            = vault_mount.transit.path
  name               = var.transit.key_name
  type               = "aes256-gcm96"
  deletion_allowed   = false
  exportable         = false
  auto_rotate_period = var.transit.auto_rotate_period
}
