import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { assertRuntimeEnv, loadEnv } from '../../src/di/env.ts';

/**
 * Contrato entre deploy/values.yaml (este serviço) e o chart base da plataforma (platform-infra/charts/microservice):
 * renderiza o chart com os values do serviço e de um ambiente e valida o env gerado com o próprio loadEnv da API.
 * Chart: PLATFORM_CHART_DIR ou ../platform-infra/charts/microservice (ignorado se não houver chart ou helm).
 */
const CHART = resolve(process.env.PLATFORM_CHART_DIR ?? '../platform-infra/charts/microservice');
const SERVICE_VALUES = 'deploy/values.yaml';
const skip = (() => {
  if (!existsSync(join(CHART, 'Chart.yaml'))) return `chart base não encontrado em ${CHART} (defina PLATFORM_CHART_DIR)`;
  try {
    execFileSync('helm', ['version'], { stdio: 'ignore' });
    return false;
  } catch {
    return 'helm não instalado';
  }
})();

type Manifest = { kind: string; metadata: { name: string; annotations?: Record<string, string> }; spec: any };

function render(environment: string): Manifest[] {
  const out = execFileSync('helm', [
    'template', 'api-clean-architecture', CHART, '-n', 'matrixgrid',
    '-f', SERVICE_VALUES, '-f', `test/fixtures/helm/${environment}.yaml`,
  ], { encoding: 'utf8' });
  return parseAllDocuments(out).map(doc => doc.toJS()).filter(Boolean);
}

/** O env do container, com os arquivos de /vault/secrets trocados por arquivos temporários de conteúdo plausível. */
function envOf(manifest: Manifest, dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { name, value } of manifest.spec.template.spec.containers[0].env as { name: string; value: string }[]) {
    if (typeof value === 'string' && value.startsWith('/vault/secrets/')) {
      const file = join(dir, value.slice('/vault/secrets/'.length));
      writeFileSync(file, name === 'MFA_ENCRYPTION_KEY_FILE' ? Buffer.alloc(32, 1).toString('base64') : 'valor-de-teste');
      env[name] = file;
    } else {
      env[name] = value;
    }
  }
  return env;
}

const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('Chart base da plataforma + deploy/values.yaml', { skip }, () => {
  test('dev: o env do Deployment passa na validação da API e cada arquivo esperado tem template no Agent', () => withDir(dir => {
    const deployment = render('dev').find(m => m.kind === 'Deployment') as Manifest;
    const env = loadEnv(envOf(deployment, dir));
    assertRuntimeEnv(env);
    assert.equal(env.MFA_CIPHER, 'vault-transit');
    assert.equal(env.VAULT_ADDR, 'http://127.0.0.1:8200', 'proxy do Agent no pod');
    assert.equal(env.VAULT_TRANSIT_MOUNT, 'dev/transit');
    assert.equal(env.VAULT_TRANSIT_KEY, 'matrixgrid-api-clean-architecture');
    assert.ok(env.tls.server && env.tls.mongo && env.tls.redis && env.tls.rabbitmq && env.tls.influx);

    const annotations = deployment.spec.template.metadata.annotations as Record<string, string>;
    assert.equal(annotations['vault.hashicorp.com/role'], 'matrixgrid-api-clean-architecture');
    assert.equal(annotations['vault.hashicorp.com/auth-path'], 'auth/k8s-dev');
    const injected = Object.keys(annotations)
      .filter(key => key.startsWith('vault.hashicorp.com/agent-inject-template-'))
      .map(key => key.replace('vault.hashicorp.com/agent-inject-template-', ''));
    const expected = (deployment.spec.template.spec.containers[0].env as { value?: string }[])
      .map(item => item.value)
      .filter((value): value is string => typeof value === 'string' && value.startsWith('/vault/secrets/'))
      .map(value => value.slice('/vault/secrets/'.length))
      .filter(name => name !== 'api-key'); // escrito pelo template api-cert (writeToFile)
    for (const name of new Set(expected)) assert.ok(injected.includes(name), `sem template do Agent para ${name}`);
    assert.match(annotations['vault.hashicorp.com/agent-inject-template-api-cert'], /pkiCert "dev\/pki\/issue\/matrixgrid-api-clean-architecture"/);
    assert.match(annotations['vault.hashicorp.com/agent-inject-template-mongo-password'], /dev\/database\/creds\/matrixgrid-api-clean-architecture/);
    for (const [key, value] of Object.entries(annotations)) assert.doesNotMatch(value, /@@[A-Z_]+@@/, key);
  }));

  test('o job de migração recebe só o que o Mongo precisa, e a configuração dele é válida', () => withDir(dir => {
    const job = render('dev').find(m => m.kind === 'Job') as Manifest;
    assert.deepEqual(job.spec.template.spec.containers[0].command, ['node', 'src/main/migrate.ts']);
    const env = loadEnv(envOf(job, dir));
    assert.equal(env.REPOSITORY_DRIVER, 'mongo');
    assert.equal(env.TIMESERIES_DRIVER, 'memory');
    const injected = Object.keys(job.spec.template.metadata.annotations).filter(key => key.includes('agent-inject-template-'));
    assert.equal(injected.length, 4);
  }));

  test('sem Vault: segredos de um Secret existente, montado no mesmo caminho', () => withDir(dir => {
    const manifests = render('no-vault');
    const deployment = manifests.find(m => m.kind === 'Deployment') as Manifest;
    assert.equal(deployment.spec.template.metadata.annotations?.['vault.hashicorp.com/agent-inject'], undefined);
    assert.equal(deployment.spec.template.spec.volumes.find((v: { name: string }) => v.name === 'secrets').secret.secretName, 'api-secrets');
    assertRuntimeEnv(loadEnv(envOf(deployment, dir)));
    assert.ok(!manifests.some(m => m.kind === 'Ingress' || m.kind === 'Job' || m.kind === 'HorizontalPodAutoscaler'));
  }));
});
