import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRuntimeEnv, loadEnv } from '../../src/di/env.ts';
import { currentSecret, watchedFiles } from '../../src/di/secrets.ts';
import { SecretFileWatcher } from '../../src/infrastructure/secrets/secret.file.watcher.ts';

const withDir = async (fn: (file: (name: string, content?: string) => string) => Promise<void> | void) => {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
  const file = (name: string, content?: string) => {
    const path = join(dir, name);
    if (content !== undefined) writeFileSync(path, content);
    return path;
  };
  try {
    await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const key = Buffer.alloc(32, 1).toString('base64');

describe('Segredos em arquivo (<VAR>_FILE)', () => {
  test('lê o valor do arquivo (sem a quebra de linha final) e guarda o caminho para a recarga', () => withDir(file => {
    const env = loadEnv({
      REPOSITORY_DRIVER: 'mongo',
      MONGO_URI: 'mongodb://mongo:27017',
      MONGO_USERNAME_FILE: file('user', 'v-api-abc\n'),
      MONGO_PASSWORD_FILE: file('pass', 's3nh@\n'),
      MFA_ENCRYPTION_KEY_FILE: file('key', `${key}\n`),
    });
    assert.equal(env.REPOSITORY_DRIVER === 'mongo' && env.MONGO_USERNAME, 'v-api-abc');
    assert.equal(env.MFA_ENCRYPTION_KEY, key);
    assert.equal(env.secretFiles.MONGO_PASSWORD, file('pass'));

    writeFileSync(file('pass'), 'nova-senha\n'); // o Vault Agent renovou a credencial
    assert.equal(currentSecret(env, 'MONGO_PASSWORD'), 'nova-senha');
    assert.deepEqual(watchedFiles(env, ['MONGO_USERNAME', 'MONGO_PASSWORD', 'MONGO_URI']), [file('user'), file('pass')]);
  }));

  test('valor e arquivo ao mesmo tempo, ou arquivo ausente, são recusados com mensagem clara', () => withDir(file => {
    assert.throws(() => loadEnv({ ADMIN_PASSWORD: 'x'.repeat(8), ADMIN_PASSWORD_FILE: file('a', 'y'.repeat(8)) }), /ADMIN_PASSWORD ou ADMIN_PASSWORD_FILE/);
    assert.throws(() => loadEnv({ INFLUX_TOKEN_FILE: '/nao/existe' }), /INFLUX_TOKEN_FILE: não foi possível ler \/nao\/existe/);
  }));

  test('MFA_CIPHER=vault-transit dispensa MFA_ENCRYPTION_KEY com mongo, mas exige VAULT_ADDR', () => {
    const mongo = { REPOSITORY_DRIVER: 'mongo', MONGO_URI: 'mongodb://m' };
    assert.throws(() => assertRuntimeEnv(loadEnv(mongo)), /MFA_ENCRYPTION_KEY/);
    assert.throws(() => assertRuntimeEnv(loadEnv({ ...mongo, MFA_CIPHER: 'vault-transit' })), /exige VAULT_ADDR/);
    assert.doesNotThrow(() => loadEnv(mongo), 'npm run db:migrate não precisa da chave do MFA');
    const env = loadEnv({ ...mongo, MFA_CIPHER: 'vault-transit', VAULT_ADDR: 'http://127.0.0.1:8100' });
    assertRuntimeEnv(env);
    assert.equal(env.VAULT_TRANSIT_KEY, 'mfa');
    assert.throws(() => loadEnv({ VAULT_ADDR: 'http://v:8200', VAULT_TLS: 'true' }), /VAULT_ADDR com https/);
  });
});

describe('Recarga de segredos e certificados', () => {
  test('reconfigura só quando o conteúdo muda; se falhar, tenta de novo no ciclo seguinte', () => withDir(async file => {
    const watcher = new SecretFileWatcher();
    const path = file('password', 'v1');
    const seen: string[] = [];
    let failNext = false;
    watcher.add({
      name: 'banco',
      files: [path],
      reload: async () => {
        if (failNext) {
          failNext = false;
          throw new Error('arquivo pela metade');
        }
        seen.push('reload');
      },
    });
    watcher.add({ name: 'sem arquivos', files: [], reload: async () => { throw new Error('não deveria rodar'); } });
    assert.deepEqual(watcher.watching, ['banco']);

    await watcher.start(60_000);
    await watcher.check();
    assert.deepEqual(seen, [], 'nada mudou');

    writeFileSync(path, 'v2');
    failNext = true;
    await watcher.check();
    assert.deepEqual(seen, [], 'falhou: continua com a anterior');
    await watcher.check();
    assert.deepEqual(seen, ['reload'], 'tentou de novo e conseguiu');
    await watcher.check();
    assert.deepEqual(seen, ['reload']);

    rmSync(path);
    await watcher.check(); // arquivo sumiu no meio da troca: só registra e espera
    writeFileSync(path, 'v3');
    await watcher.check();
    assert.deepEqual(seen, ['reload', 'reload']);
    await watcher.stop();
  }));
});
