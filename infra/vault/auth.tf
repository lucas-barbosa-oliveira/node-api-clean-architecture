# Como a API (o Vault Agent ao lado dela) se autentica.

# Kubernetes: o token da ServiceAccount do pod prova quem ele é. Nenhum segredo de bootstrap.
resource "vault_auth_backend" "kubernetes" {
  count = var.kubernetes == null ? 0 : 1
  type  = "kubernetes"
  path  = "kubernetes"
}

resource "vault_kubernetes_auth_backend_config" "kubernetes" {
  count              = var.kubernetes == null ? 0 : 1
  backend            = vault_auth_backend.kubernetes[0].path
  kubernetes_host    = var.kubernetes.host
  kubernetes_ca_cert = var.kubernetes.ca_cert
}

resource "vault_kubernetes_auth_backend_role" "api" {
  count                            = var.kubernetes == null ? 0 : 1
  backend                          = vault_auth_backend.kubernetes[0].path
  role_name                        = local.role
  bound_service_account_names      = var.kubernetes.service_accounts
  bound_service_account_namespaces = var.kubernetes.namespaces
  audience                         = var.kubernetes.audience
  token_policies                   = [vault_policy.api.name]
  token_ttl                        = var.kubernetes.token_ttl
}

# AppRole: Vault Agent fora do Kubernetes (ambiente local, em container).
resource "vault_auth_backend" "approle" {
  count = var.approle == null ? 0 : 1
  type  = "approle"
  path  = "approle"
}

resource "vault_approle_auth_backend_role" "api" {
  count          = var.approle == null ? 0 : 1
  backend        = vault_auth_backend.approle[0].path
  role_name      = local.role
  token_policies = [vault_policy.api.name]
  token_ttl      = 3600
  token_max_ttl  = 86400
}

resource "vault_approle_auth_backend_role_secret_id" "api" {
  count     = var.approle == null ? 0 : 1
  backend   = vault_auth_backend.approle[0].path
  role_name = vault_approle_auth_backend_role.api[0].role_name
}

resource "local_file" "approle_role_id" {
  count           = var.approle == null ? 0 : 1
  filename        = "${var.approle.output_dir}/role-id"
  content         = vault_approle_auth_backend_role.api[0].role_id
  file_permission = "0644"
}

resource "local_sensitive_file" "approle_secret_id" {
  count           = var.approle == null ? 0 : 1
  filename        = "${var.approle.output_dir}/secret-id"
  content         = vault_approle_auth_backend_role_secret_id.api[0].secret_id
  file_permission = "0644" # lido pelo Agent em container (outro uid); só no ambiente local
}
