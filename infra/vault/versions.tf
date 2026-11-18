# Configuração do Vault (ou OpenBao) da API, como código. O mesmo módulo serve ao Vault local de desenvolvimento
# (envs/local.tfvars, aplicado por npm run vault:bootstrap) e aos ambientes do Kubernetes (variáveis do DevOps).
#
# Requer OpenTofu >= 1.8. O provider "hashicorp/vault" também funciona com o OpenBao.
terraform {
  required_version = ">= 1.8.0"

  required_providers {
    vault = {
      source  = "hashicorp/vault"
      version = ">= 4.8.0, < 6.0.0"
    }
    # local: só no ambiente local (grava certificados dos serviços e credenciais do AppRole em disco)
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    # tls: gera o par de chaves dos JWTs quando generate_jwt_keys = true
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # Estado cifrado (recurso do OpenTofu): o estado deste módulo contém dados sensíveis (ex.: chave dos JWTs gerada
  # aqui, senha de administração do banco). Em produção, configure pela variável de ambiente TF_ENCRYPTION, com uma
  # chave no KMS da nuvem (exemplo em envs/encryption.example.hcl). No ambiente local o estado é descartável.
}

# Endereço e token vêm das variáveis de ambiente VAULT_ADDR e VAULT_TOKEN (nunca do código).
provider "vault" {}
