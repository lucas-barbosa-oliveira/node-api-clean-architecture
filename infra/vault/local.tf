# Só no ambiente local (local_certs != null): certificados dos serviços de infraestrutura emitidos pela PKI do Vault
# e gravados nos mesmos nomes do npm run tls:setup (certs/), para o docker-compose.tls.yml funcionar sem mudança.
locals {
  local_services = var.local_certs == null ? {} : var.local_certs.services
}

resource "vault_pki_secret_backend_cert" "local" {
  for_each    = local.local_services
  backend     = vault_mount.pki_int.path
  name        = vault_pki_secret_backend_role.infra.name
  common_name = each.key
  alt_names   = [for name in each.value : name if !can(regex("^[0-9.]+$", name))]
  ip_sans     = [for name in each.value : name if can(regex("^[0-9.]+$", name))]
  ttl         = var.local_certs.ttl
  auto_renew  = true
}

resource "local_file" "local_ca" {
  count           = var.local_certs == null ? 0 : 1
  filename        = "${var.local_certs.output_dir}/ca.crt"
  content         = vault_pki_secret_backend_root_cert.root.certificate
  file_permission = "0644"
}

# certificado + intermediária (a cadeia que o servidor apresenta)
resource "local_file" "local_cert" {
  for_each        = vault_pki_secret_backend_cert.local
  filename        = "${var.local_certs.output_dir}/${each.key}.crt"
  content         = "${each.value.certificate}\n${each.value.issuing_ca}\n"
  file_permission = "0644"
}

resource "local_sensitive_file" "local_key" {
  for_each        = vault_pki_secret_backend_cert.local
  filename        = "${var.local_certs.output_dir}/${each.key}.key"
  content         = each.value.private_key
  file_permission = "0644" # cada container roda com um uid diferente; só no ambiente local
}

# mongod quer certificado e chave num arquivo só
resource "local_sensitive_file" "local_mongo_pem" {
  for_each        = { for name, cert in vault_pki_secret_backend_cert.local : name => cert if name == "mongo" }
  filename        = "${var.local_certs.output_dir}/mongo.pem"
  content         = "${each.value.certificate}\n${each.value.issuing_ca}\n${each.value.private_key}\n"
  file_permission = "0644"
}

# chave pública dos JWTs para o kong:setup (o Kong só valida; a privada fica no Vault)
resource "local_file" "jwt_public_key" {
  count           = var.jwt_public_key_file != null && var.generate_jwt_keys ? 1 : 0
  filename        = var.jwt_public_key_file
  content         = tls_private_key.jwt[0].public_key_pem
  file_permission = "0644"
}
