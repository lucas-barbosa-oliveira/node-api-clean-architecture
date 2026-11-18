/* global db, rs, quit -- script do mongosh (variáveis globais do shell do MongoDB) */
// Healthcheck do Mongo no modo Vault (docker-compose.vault.yml): replica set + autenticação ligada.
// Na primeira subida, pela exceção de localhost (nenhum usuário ainda): inicia o replica set e cria o administrador que
// o Vault usa para gerar usuários temporários. Depois, só autentica e confere se há primário.
const admin = db.getSiblingDB('admin')
const user = 'vault-admin'
const pwd = 'vault-admin-local' // o mesmo de mongodb_password em infra/vault/envs/local.tfvars (desenvolvimento)

let authenticated = false
try {
  authenticated = Boolean(admin.auth(user, pwd))
} catch {
  // ainda não existe
}

if (!authenticated) {
  try {
    rs.status()
  } catch {
    rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] })
    quit(1)
  }
  if (!db.hello().isWritablePrimary) quit(1)
  admin.createUser({ user, pwd, roles: ['root'] })
  admin.auth(user, pwd)
}

quit(db.hello().isWritablePrimary ? 0 : 1)
