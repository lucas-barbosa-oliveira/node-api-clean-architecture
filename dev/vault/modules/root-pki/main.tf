# CA raiz de um Vault. A chave privada nunca sai do Vault e só assina as intermediárias de cada ambiente.
terraform {
  required_providers {
    vault = { source = "hashicorp/vault", version = ">= 4.8.0, < 6.0.0" }
  }
}

variable "mount_path" {
  type    = string
  default = "pki-root"
}

variable "common_name" {
  type = string
}

variable "organization" {
  type = string
}

variable "ttl" {
  type    = string
  default = "87600h" # 10 anos
}

variable "key_type" {
  type    = string
  default = "ec"
}

variable "key_bits" {
  type    = number
  default = 256
}

resource "vault_mount" "root" {
  path                  = var.mount_path
  type                  = "pki"
  max_lease_ttl_seconds = 315360000
  description           = "CA raiz"
}

resource "vault_pki_secret_backend_root_cert" "root" {
  backend      = vault_mount.root.path
  type         = "internal"
  common_name  = var.common_name
  organization = var.organization
  ttl          = var.ttl
  key_type     = var.key_type
  key_bits     = var.key_bits
}

output "mount_path" {
  value = vault_mount.root.path
}

output "certificate" {
  description = "Âncora de confiança (TLS_CA_FILE dos serviços, CA do Kong e dos bancos)."
  value       = vault_pki_secret_backend_root_cert.root.certificate
}
