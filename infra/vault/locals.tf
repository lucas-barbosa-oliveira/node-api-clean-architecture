locals {
  mounts = {
    kv       = var.mounts.kv
    pki_root = var.mounts.pki_root
    pki_int  = var.mounts.pki_int
    database = var.mounts.database
    rabbitmq = var.mounts.rabbitmq
    transit  = var.mounts.transit
  }
  # papel (role) do serviço em todos os motores e métodos de autenticação
  role = "api"
}
