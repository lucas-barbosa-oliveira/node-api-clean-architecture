import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { assertRuntimeEnv, loadEnv } from '../../src/di/env.ts';

const CHART = 'deploy/helm/api-clean-architecture';
const hasHelm = (() => {
  try {
    execFileSync('helm', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

type Manifest = { kind: string; metadata: { name: string; annotations?: Record<string, string> }; spec: any };

function render(valuesFile: string): Manifest[] {
  const out = execFileSync('helm', ['template', 'api', CHART, '-n', 'api', '-f', `${CHART}/ci/${valuesFile}`], { encoding: 'utf8' });
  return parseAllDocuments(out).map(doc => doc.toJS()).filter(Boolean);
}

/** O env do container, com os arquivos de /vault/secrets trocados por arquivos temporários de conteúdo plausível. */
function envOf(manifest: Manifest, dir: string): Record<string, string> {
  const container = manifest.spec.template.spec.containers[0];
  const env: Record<string, string> = {};
  for (const { name, value } of container.env as { name: string; value: string }[]) {
    if (typeof value === 'string' && value.startsWith('/vault/secrets/')) {
      const file = join(dir, value.slice('/vault/secrets/'.length));
      const content = name === 'MFA_ENCRYPTION_KEY_FILE' ? Buffer.alloc(32, 1).toString('base64') : 'valor-de-teste';
      writeFileSync(file, content);
      env[name] = file;
    } else {
      env[name] = value;
    }
  }
  return env;
}

describe('Chart Helm: contrato com a aplicação', { skip: !hasHelm && 'helm não instalado' }, () => {
  test('com Vault: o env do Deployment passa na validação da API e cada arquivo esperado tem template no Agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-'));
    try {
      const manifests = render('default-values.yaml');
      const deployment = manifests.find(m => m.kind === 'Deployment') as Manifest;
      const env = loadEnv(envOf(deployment, dir));
      assertRuntimeEnv(env);
      assert.equal(env.MFA_CIPHER, 'vault-transit');
      assert.equal(env.REPOSITORY_DRIVER === 'mongo' && env.MONGO_AUTO_INDEX, false);
      assert.ok(env.tls.server && env.tls.mongo && env.tls.redis && env.tls.rabbitmq && env.tls.influx);

      const annotations = deployment.spec.template.metadata.annotations as Record<string, string>;
      const injected = Object.keys(annotations)
        .filter(key => key.startsWith('vault.hashicorp.com/agent-inject-template-'))
        .map(key => key.replace('vault.hashicorp.com/agent-inject-template-', ''));
      const container = deployment.spec.template.spec.containers[0];
      const expected = (container.env as { value?: string }[])
        .map(item => item.value)
        .filter((value): value is string => typeof value === 'string' && value.startsWith('/vault/secrets/'))
        .map(value => value.slice('/vault/secrets/'.length))
        .filter(name => name !== 'api-key'); // escrito pelo template api-cert (writeToFile)
      for (const name of new Set(expected)) assert.ok(injected.includes(name), `sem template do Agent para ${name}`);
      assert.match(annotations['vault.hashicorp.com/agent-inject-template-api-cert'], /pkiCert "pki_int\/issue\/api" "common_name=api-api-clean-architecture\.api\.svc"/);
      assert.doesNotMatch(annotations['vault.hashicorp.com/agent-inject-template-api-cert'], /@@[A-Z_]+@@/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('o job de migração recebe só o que o Mongo precisa, e a configuração dele é válida', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-'));
    try {
      const job = render('default-values.yaml').find(m => m.kind === 'Job') as Manifest;
      assert.deepEqual(job.spec.template.spec.containers[0].command, ['node', 'src/main/migrate.ts']);
      const env = loadEnv(envOf(job, dir));
      assert.equal(env.REPOSITORY_DRIVER, 'mongo');
      assert.equal(env.TIMESERIES_DRIVER, 'memory');
      const injected = Object.keys(job.spec.template.metadata.annotations).filter(key => key.includes('agent-inject-template-'));
      assert.equal(injected.length, 4);
      assert.equal(job.spec.template.metadata.annotations['vault.hashicorp.com/agent-pre-populate-only'], 'true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sem Vault: segredos de um Secret existente, montado no mesmo caminho', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-'));
    try {
      const manifests = render('no-vault-values.yaml');
      const deployment = manifests.find(m => m.kind === 'Deployment') as Manifest;
      assert.equal(deployment.spec.template.metadata.annotations?.['vault.hashicorp.com/agent-inject'], undefined);
      assert.equal(deployment.spec.template.spec.volumes.find((v: { name: string }) => v.name === 'secrets').secret.secretName, 'api-secrets');
      assertRuntimeEnv(loadEnv(envOf(deployment, dir)));
      assert.ok(!manifests.some(m => m.kind === 'Ingress' || m.kind === 'Job' || m.kind === 'HorizontalPodAutoscaler'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
