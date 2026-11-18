output "policy" {
  description = "Política da API."
  value       = vault_policy.api.name
}

output "root_ca_pem" {
  description = "CA raiz: âncora de confiança dos clientes (TLS_CA_FILE) e do Kong (verificação da API)."
  value       = vault_pki_secret_backend_root_cert.root.certificate
}

output "jwt_public_key_pem" {
  description = "Chave pública dos JWTs, para o consumer do Kong."
  value       = var.generate_jwt_keys ? tls_private_key.jwt[0].public_key_pem : null
}

output "mounts" {
  description = "Caminhos dos motores (os templates do Vault Agent dependem deles)."
  value       = local.mounts
}

output "approle_role_id" {
  value = var.approle == null ? null : vault_approle_auth_backend_role.api[0].role_id
}
