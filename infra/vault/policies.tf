# O que a API pode fazer no Vault: só ler os próprios segredos e usar os próprios papéis.
resource "vault_policy" "api" {
  name = var.app_name
  policy = templatefile("${path.module}/policies/api.hcl.tftpl", {
    role        = local.role
    kv          = local.mounts.kv
    pki_root    = local.mounts.pki_root
    pki_int     = local.mounts.pki_int
    database    = local.mounts.database
    rabbitmq    = local.mounts.rabbitmq
    transit     = local.mounts.transit
    transit_key = var.transit.key_name
  })
}
