variable "environment" {
  description = "Nome do ambiente (local, staging, production): aparece nos nomes e metadados."
  type        = string
}

variable "app_name" {
  description = "Nome do serviço: nome da política, dos papéis e dos caminhos no KV."
  type        = string
  default     = "api-clean-architecture"
}

# ---------- motores (caminhos de montagem) ----------
variable "mounts" {
  description = "Caminhos dos motores. Os templates do Vault Agent usam os valores padrão; mude os dois juntos."
  type = object({
    kv       = optional(string, "kv")
    pki_root = optional(string, "pki")
    pki_int  = optional(string, "pki_int")
    database = optional(string, "database")
    rabbitmq = optional(string, "rabbitmq")
    transit  = optional(string, "transit")
  })
  default = {}
}

# ---------- PKI ----------
variable "pki" {
  description = "CA raiz e intermediária, e os nomes aceitos em cada papel."
  type = object({
    organization     = optional(string, "api-clean-architecture")
    root_common_name = optional(string, "api-clean-architecture Root CA")
    int_common_name  = optional(string, "api-clean-architecture Intermediate CA")
    root_ttl         = optional(string, "87600h") # 10 anos
    int_ttl          = optional(string, "43800h") # 5 anos
    key_type         = optional(string, "ec")
    key_bits         = optional(number, 256)
    api_domains      = list(string)             # nomes do certificado da API (servidor e cliente)
    infra_domains    = list(string)             # Mongo, Redis, RabbitMQ, InfluxDB, Kong
    allow_ip_sans    = optional(bool, false)    # local: 127.0.0.1
    allow_localhost  = optional(bool, false)    # local: localhost
    leaf_ttl         = optional(string, "72h")  # validade padrão dos certificados emitidos
    leaf_max_ttl     = optional(string, "720h") # 30 dias
    crl_distribution = optional(list(string), [])
    issuing_ca_urls  = optional(list(string), [])
  })
}

# ---------- credenciais dinâmicas do MongoDB ----------
variable "mongodb" {
  description = "Conexão de administração que o Vault usa para criar usuários temporários. null desliga."
  type = object({
    connection_url = string # mongodb://{{username}}:{{password}}@host:27017/admin?tls=true
    username       = string
    tls_ca         = optional(string) # PEM da CA do Mongo
    tls_cert_key   = optional(string) # PEM certificado + chave do Vault como cliente (mTLS)
    roles          = list(object({ role = string, db = optional(string) }))
    default_ttl    = optional(number, 3600)  # 1 h: o Agent renova
    max_ttl        = optional(number, 86400) # 24 h: depois, usuário novo (a API reconecta sozinha)
  })
  default = null
}

variable "mongodb_password" {
  description = "Senha do usuário de administração do Mongo usado pelo Vault (o Vault pode rotacioná-la depois)."
  type        = string
  default     = null
  sensitive   = true
}

# ---------- credenciais dinâmicas do RabbitMQ ----------
variable "rabbitmq" {
  description = "API de administração do RabbitMQ que o Vault usa para criar usuários temporários. null desliga."
  type = object({
    connection_uri = string # http(s)://rabbitmq:15672 (a CA precisa estar no Vault se for https)
    username       = string
    vhost          = optional(string, "/")
    configure      = optional(string, ".*")
    write          = optional(string, ".*")
    read           = optional(string, ".*")
    default_ttl    = optional(number, 3600)
    max_ttl        = optional(number, 86400)
  })
  default = null
}

variable "rabbitmq_password" {
  type      = string
  default   = null
  sensitive = true
}

# ---------- Transit (cifra dos segredos do MFA) ----------
variable "transit" {
  type = object({
    key_name           = optional(string, "mfa")
    auto_rotate_period = optional(number, 2592000) # 30 dias; os segredos passam para a versão nova no próximo uso
  })
  default = {}
}

# ---------- segredos estáticos ----------
variable "generate_jwt_keys" {
  description = "Gera o par RSA dos JWTs e grava no KV (fica no estado: use estado cifrado)."
  type        = bool
  default     = true
}

variable "static_secrets" {
  description = <<-EOT
    Segredos estáticos gravados em <kv>/api/static. Só para o ambiente local (valores de desenvolvimento).
    Em produção, deixe null e grave os valores direto no Vault (vault kv put), fora do código e do estado.
  EOT
  type = object({
    influx_token   = string
    admin_password = string
    redis_password = optional(string)
  })
  default   = null
  sensitive = true
}

# ---------- autenticação ----------
variable "approle" {
  description = "AppRole para o Vault Agent fora do Kubernetes (ambiente local). Grava role-id e secret-id em output_dir."
  type = object({
    output_dir = string
  })
  default = null
}

variable "kubernetes" {
  description = "Kubernetes auth: o pod se autentica com o token da ServiceAccount."
  type = object({
    host             = string # endereço da API do Kubernetes visto pelo Vault
    ca_cert          = optional(string)
    namespaces       = list(string)
    service_accounts = list(string)
    audience         = optional(string)
    token_ttl        = optional(number, 3600)
  })
  default = null
}

# ---------- certificados emitidos na hora (ambiente local) ----------
variable "local_certs" {
  description = <<-EOT
    Ambiente local: emite os certificados dos serviços de infraestrutura (Mongo, Redis, RabbitMQ, InfluxDB, Kong) e
    grava em output_dir, nos mesmos nomes do npm run tls:setup. No Kubernetes, quem emite é o cert-manager (emissor
    Vault) ou o Vault Secrets Operator.
  EOT
  type = object({
    output_dir = string
    services   = map(list(string)) # serviço -> nomes alternativos
    ttl        = optional(string, "720h")
  })
  default = null
}

variable "audit_file_path" {
  description = "Liga a auditoria em arquivo (\"stdout\" manda para os logs do container). Vazio desliga."
  type        = string
  default     = ""
}

variable "jwt_public_key_file" {
  description = "Ambiente local: grava a chave pública dos JWTs neste arquivo (lido pelo npm run kong:setup)."
  type        = string
  default     = null
}
