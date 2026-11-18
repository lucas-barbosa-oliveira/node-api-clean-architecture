# PKI em dois níveis: a raiz só assina a intermediária; os certificados dos serviços saem da intermediária.
# Em produção, a raiz pode ficar fora do Vault (CA corporativa): assine o CSR de vault_pki_secret_backend_intermediate_cert_request
# externamente e importe com vault_pki_secret_backend_intermediate_set_signed.

resource "vault_mount" "pki_root" {
  path                  = local.mounts.pki_root
  type                  = "pki"
  max_lease_ttl_seconds = 315360000 # 10 anos
  description           = "CA raiz (${var.environment})"
}

resource "vault_pki_secret_backend_root_cert" "root" {
  backend      = vault_mount.pki_root.path
  type         = "internal" # a chave privada da raiz nunca sai do Vault
  common_name  = var.pki.root_common_name
  organization = var.pki.organization
  ttl          = var.pki.root_ttl
  key_type     = var.pki.key_type
  key_bits     = var.pki.key_bits
}

resource "vault_mount" "pki_int" {
  path                  = local.mounts.pki_int
  type                  = "pki"
  max_lease_ttl_seconds = 157680000 # 5 anos
  description           = "CA intermediária dos serviços (${var.environment})"
}

resource "vault_pki_secret_backend_intermediate_cert_request" "int" {
  backend      = vault_mount.pki_int.path
  type         = "internal"
  common_name  = var.pki.int_common_name
  organization = var.pki.organization
  key_type     = var.pki.key_type
  key_bits     = var.pki.key_bits
}

resource "vault_pki_secret_backend_root_sign_intermediate" "int" {
  backend     = vault_mount.pki_root.path
  csr         = vault_pki_secret_backend_intermediate_cert_request.int.csr
  common_name = var.pki.int_common_name
  ttl         = var.pki.int_ttl
  # a intermediária só assina certificados finais
  max_path_length = 0
  depends_on      = [vault_pki_secret_backend_root_cert.root]
}

resource "vault_pki_secret_backend_intermediate_set_signed" "int" {
  backend     = vault_mount.pki_int.path
  certificate = vault_pki_secret_backend_root_sign_intermediate.int.certificate
}

resource "vault_pki_secret_backend_config_urls" "int" {
  count                   = length(var.pki.crl_distribution) > 0 ? 1 : 0
  backend                 = vault_mount.pki_int.path
  issuing_certificates    = var.pki.issuing_ca_urls
  crl_distribution_points = var.pki.crl_distribution
}

# Certificado da API: servidor HTTPS e identidade como cliente (mTLS com Mongo, Redis, RabbitMQ).
resource "vault_pki_secret_backend_role" "api" {
  backend            = vault_mount.pki_int.path
  name               = local.role
  allowed_domains    = var.pki.api_domains
  allow_bare_domains = true
  allow_subdomains   = false
  allow_glob_domains = false
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

# Certificados dos serviços de infraestrutura e do Kong (emitidos pela plataforma: cert-manager com emissor Vault).
resource "vault_pki_secret_backend_role" "infra" {
  backend            = vault_mount.pki_int.path
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
