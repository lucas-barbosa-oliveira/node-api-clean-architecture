# Usuários temporários do RabbitMQ, com permissão só no vhost do serviço.
resource "vault_rabbitmq_secret_backend" "rabbitmq" {
  count                     = var.rabbitmq == null ? 0 : 1
  path                      = local.mounts.rabbitmq
  connection_uri            = var.rabbitmq.connection_uri
  username                  = var.rabbitmq.username
  password                  = var.rabbitmq_password
  verify_connection         = false
  default_lease_ttl_seconds = var.rabbitmq.default_ttl
  max_lease_ttl_seconds     = var.rabbitmq.max_ttl
  description               = "Credenciais dinâmicas do RabbitMQ (${var.environment})"
}

resource "vault_rabbitmq_secret_backend_role" "api" {
  count   = var.rabbitmq == null ? 0 : 1
  backend = vault_rabbitmq_secret_backend.rabbitmq[0].path
  name    = local.role
  tags    = ""

  vhost {
    host      = var.rabbitmq.vhost
    configure = var.rabbitmq.configure
    write     = var.rabbitmq.write
    read      = var.rabbitmq.read
  }
}
