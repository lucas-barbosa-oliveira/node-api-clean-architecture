# Vault Agent do ambiente local (container vault-agent do docker-compose.vault.yml). No Kubernetes, o equivalente é
# gerado pelo Agent Injector a partir das anotações do chart Helm.
pid_file = "/tmp/vault-agent.pid"

vault {
  address = "http://vault:8200"
}

# AppRole: role-id e secret-id gravados por npm run vault:bootstrap (no Kubernetes: token da ServiceAccount)
auto_auth {
  method "approle" {
    mount_path = "auth/approle-local" # módulo environment: approle-<ambiente>
    config = {
      role_id_file_path                   = "/vault/approle/role-id"
      secret_id_file_path                 = "/vault/approle/secret-id"
      remove_secret_id_file_after_reading = false
    }
  }
}

# A API chama o Transit por aqui, sem token: o Agent injeta o dele (VAULT_ADDR=http://vault-agent:8100)
api_proxy {
  use_auto_auth_token = true
}

listener "tcp" {
  address     = "0.0.0.0:8100"
  tls_disable = true # só na rede interna do compose; no Kubernetes o Agent escuta em 127.0.0.1 dentro do pod
}

template_config {
  # credenciais dinâmicas são renovadas pelo Agent; segredos estáticos (KV) são relidos neste intervalo
  static_secret_render_interval = "1m"
  exit_on_retry_failure         = false
}
