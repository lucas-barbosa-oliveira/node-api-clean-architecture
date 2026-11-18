# Auditoria: toda requisição ao Vault (quem leu qual segredo), com os valores em hash.
resource "vault_audit" "file" {
  count = var.audit_file_path == "" ? 0 : 1
  type  = "file"
  options = {
    file_path = var.audit_file_path
  }
}
