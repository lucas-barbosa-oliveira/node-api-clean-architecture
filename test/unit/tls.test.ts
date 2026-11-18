import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../../src/application/port/logger.ts';
import { loadEnv } from '../../src/di/env.ts';
import { readTlsClientOptions, type TlsClientOptions } from '../../src/infrastructure/security/tls.ts';
import { startHttpServer, type HttpServer } from '../../src/main/http.server.ts';
import { generateCertificates, hasOpenSsl } from '../../scripts/tls.certificates.ts';

const MONGO_BASE = { REPOSITORY_DRIVER: 'mongo', MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

describe('TLS: variáveis de ambiente', () => {
  const rabbit = { EVENT_BUS_DRIVER: 'rabbitmq', RABBITMQ_URI: 'amqps://app:senha@rabbit:5671' };

  test('sem nenhuma variável, nada usa TLS', () => {
    assert.deepEqual(loadEnv({}).tls, {});
  });

  test('o esquema seguro na URL liga o TLS e herda a CA e a identidade padrão (TLS_*)', () => {
    const { tls } = loadEnv({
      ...rabbit,
      TLS_CA_FILE: '/certs/ca.crt',
      TLS_CLIENT_CERT_FILE: '/certs/api.crt',
      TLS_CLIENT_KEY_FILE: '/certs/api.key',
    });
    assert.deepEqual(tls.rabbitmq, {
      caFile: '/certs/ca.crt',
      certFile: '/certs/api.crt',
      keyFile: '/certs/api.key',
      servername: undefined,
      rejectUnauthorized: true,
    });
  });

  test('a variável do serviço prevalece sobre o padrão', () => {
    const { tls } = loadEnv({
      ...rabbit,
      TLS_CA_FILE: '/certs/ca.crt',
      RABBITMQ_TLS_CA_FILE: '/outra/ca.crt',
      RABBITMQ_TLS_REJECT_UNAUTHORIZED: 'false',
    });
    assert.equal(tls.rabbitmq?.caFile, '/outra/ca.crt');
    assert.equal(tls.rabbitmq?.rejectUnauthorized, false);
  });

  test('MongoDB: MONGO_TLS=true ou tls=true na URI', () => {
    const mongo = { ...MONGO_BASE, MONGO_URI: 'mongodb://mongo:27017/?directConnection=true' };
    assert.equal(loadEnv(mongo).tls.mongo, undefined);
    assert.ok(loadEnv({ ...mongo, MONGO_TLS: 'true' }).tls.mongo);
    assert.ok(loadEnv({ ...mongo, MONGO_URI: 'mongodb://mongo:27017/?tls=true' }).tls.mongo);
  });

  test('Redis: rediss:// ou REDIS_TLS=true', () => {
    const redis = { ...MONGO_BASE, MONGO_URI: 'mongodb://m', QUEUE_DRIVER: 'redis' };
    assert.ok(loadEnv({ ...redis, REDIS_URL: 'rediss://redis:6379' }).tls.redis);
    assert.ok(loadEnv({ ...redis, REDIS_URL: 'redis://redis:6379', REDIS_TLS: 'true' }).tls.redis);
  });

  test('combinações incoerentes são recusadas na inicialização', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ EVENT_BUS_DRIVER: 'rabbitmq', RABBITMQ_URI: 'amqp://rabbit', RABBITMQ_TLS: 'true' }, /exige RABBITMQ_URI com amqps:\/\//],
      [{ TIMESERIES_DRIVER: 'influx', INFLUX_URL: 'http://influx', INFLUX_TOKEN: 't', INFLUX_ORG: 'o', INFLUX_BUCKET: 'b',
        INFLUX_TLS: 'true' }, /exige INFLUX_URL com https:\/\//],
      [{ EVENT_BUS_DRIVER: 'rabbitmq', RABBITMQ_URI: 'amqp://rabbit', RABBITMQ_TLS_CA_FILE: '/ca.crt' }, /TLS do RabbitMQ está desligado/],
      [{ ...rabbit, TLS_CLIENT_CERT_FILE: '/api.crt' }, /certificado e a chave de cliente juntos/],
      [{ SERVER_TLS: 'true' }, /SERVER_TLS=true exige SERVER_TLS_CERT_FILE e SERVER_TLS_KEY_FILE/],
      [{ SERVER_TLS: 'true', SERVER_TLS_CERT_FILE: '/a', SERVER_TLS_KEY_FILE: '/b', SERVER_TLS_CLIENT_AUTH: 'require' },
        /exige SERVER_TLS_CA_FILE/],
      [{ SERVER_TLS_CERT_FILE: '/a' }, /SERVER_TLS não é true/],
    ];
    for (const [env, message] of cases) assert.throws(() => loadEnv(env), message, JSON.stringify(env));
  });

  test('arquivo de certificado ausente vira erro claro (não falha de conexão)', () => {
    assert.throws(
      () => readTlsClientOptions({ caFile: '/nao/existe/ca.crt', rejectUnauthorized: true }),
      /TLS: não foi possível ler a CA em \/nao\/existe\/ca\.crt/,
    );
  });
});

describe('TLS: servidor HTTPS da API com mTLS', { skip: !hasOpenSsl() && 'openssl não instalado' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tls-test-'));
  const file = (name: string) => join(dir, name);
  let http: HttpServer;
  let port: number;
  let client: TlsClientOptions;

  before(async () => {
    generateCertificates(dir, [
      { name: 'api', dnsNames: ['localhost'], ips: ['127.0.0.1'] },
      { name: 'kong', dnsNames: ['kong'] },
    ]);
    const { tls } = loadEnv({
      SERVER_TLS: 'true',
      SERVER_TLS_CERT_FILE: file('api.crt'),
      SERVER_TLS_KEY_FILE: file('api.key'),
      SERVER_TLS_CA_FILE: file('ca.crt'),
      SERVER_TLS_CLIENT_AUTH: 'require',
    });
    http = startHttpServer((_req, res) => res.end('ok'), { port: 0, tls: tls.server, logger: silentLogger });
    await new Promise(resolve => http.server.once('listening', resolve));
    port = (http.server.address() as AddressInfo).port;
    client = readTlsClientOptions({
      caFile: file('ca.crt'), certFile: file('kong.crt'), keyFile: file('kong.key'), rejectUnauthorized: true,
    });
  });
  after(async () => {
    await new Promise(resolve => http.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (options: TlsClientOptions) => new Promise<{ status?: number; certSerial: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', agent: false, ...options }, res => {
      res.resume();
      resolve({ status: res.statusCode, certSerial: res.socket && 'getPeerCertificate' in res.socket
        ? (res.socket as import('node:tls').TLSSocket).getPeerCertificate().serialNumber : '' });
    });
    req.on('error', reject);
    req.end();
  });

  test('cliente com certificado da CA é atendido, e o certificado da API é verificado pela CA', async () => {
    assert.equal((await get(client)).status, 200);
  });

  test('cliente sem certificado é recusado no handshake', async () => {
    await assert.rejects(get({ ca: client.ca }), /certificate|alert|socket hang up|ECONNRESET/i);
  });

  test('cliente que não confia na CA recusa o certificado da API', async () => {
    await assert.rejects(get({ cert: client.cert, key: client.key }), /self[- ]signed|unable to (get|verify)/i);
  });

  test('reloadTls troca o certificado sem reiniciar o servidor', async () => {
    const before = (await get(client)).certSerial;
    // força uma CA e certificados novos: o servidor só aceita o cliente novo depois do reload
    generateCertificates(dir, [
      { name: 'api', dnsNames: ['localhost'], ips: ['127.0.0.1'] },
      { name: 'kong', dnsNames: ['kong'] },
    ], { force: true });
    client = readTlsClientOptions({
      caFile: file('ca.crt'), certFile: file('kong.crt'), keyFile: file('kong.key'), rejectUnauthorized: true,
    });
    await assert.rejects(get(client), 'antes do reload, o servidor ainda usa a CA antiga');
    http.reloadTls?.();
    const reloaded = await get(client);
    assert.equal(reloaded.status, 200);
    assert.notEqual(reloaded.certSerial, before);
  });
});
