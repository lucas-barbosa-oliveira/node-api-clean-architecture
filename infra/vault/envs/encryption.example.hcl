# Cifra do estado do OpenTofu (o estado deste módulo tem dados sensíveis). Use pela variável de ambiente:
#   export TF_ENCRYPTION="$(cat envs/encryption.example.hcl)"
# Troque o key_provider pelo KMS da sua nuvem (aws_kms, gcp_kms) ou pelo próprio OpenBao/Vault Transit (openbao).
key_provider "pbkdf2" "passphrase" {
  passphrase = "troque-por-uma-frase-longa-vinda-do-cofre-do-pipeline"
}

method "aes_gcm" "state" {
  keys = key_provider.pbkdf2.passphrase
}

state {
  method   = method.aes_gcm.state
  enforced = true
}

plan {
  method   = method.aes_gcm.state
  enforced = true
}
