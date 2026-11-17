import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBusUnavailableError } from '../../src/application/port/event.bus.ts';
import { HealthService } from '../../src/application/service/health.service.ts';
import { isDependencyUnavailable } from '../../src/infrastructure/resilience/unavailable.ts';

describe('HealthService', () => {
  test('pronta só com todas as dependências críticas no ar; as não críticas só aparecem no relatório', async () => {
    const health = new HealthService([
      { name: 'mongodb', critical: true, check: async () => ({ status: 'up' }) },
      { name: 'rabbitmq', critical: false, check: async () => ({ status: 'down' }) },
    ]);
    const report = await health.readiness();
    assert.equal(report.status, 'ready');
    assert.equal(report.checks.rabbitmq.status, 'down');
  });

  test('dependência crítica fora do ar, lenta ou com erro: não está pronta', async () => {
    const health = new HealthService([
      { name: 'mongodb', critical: true, check: async () => { throw new Error('ECONNREFUSED'); } },
      { name: 'redis', critical: true, check: () => new Promise(() => {}) }, // nunca responde
    ]);
    const report = await health.readiness();
    assert.equal(report.status, 'not_ready');
    assert.deepEqual(report.checks.mongodb.details, { error: 'ECONNREFUSED' });
    assert.match(String(report.checks.redis.details?.error), /sem resposta/);
  });

  test('no encerramento deixa de estar pronta (o balanceador para de mandar tráfego)', async () => {
    const health = new HealthService([]);
    health.markShuttingDown();
    assert.equal((await health.readiness()).status, 'not_ready');
    assert.equal(health.liveness().status, 'ok');
  });
});

describe('isDependencyUnavailable (503)', () => {
  const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('x'), { name }, extra);

  test('reconhece erros de conexão dos drivers, inclusive na cadeia de causas', () => {
    assert.ok(isDependencyUnavailable(named('MongoServerSelectionError')));
    assert.ok(isDependencyUnavailable(named('MaxRetriesPerRequestError')));
    assert.ok(isDependencyUnavailable(new EventBusUnavailableError()));
    assert.ok(isDependencyUnavailable(new Error('falhou', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) })));
    assert.ok(isDependencyUnavailable(new Error('Connection is closed.')));
  });

  test('bugs e erros de negócio continuam 500 / 4xx', () => {
    assert.ok(!isDependencyUnavailable(new TypeError('cannot read properties of undefined')));
    assert.ok(!isDependencyUnavailable(named('ValidationError')));
    assert.ok(!isDependencyUnavailable('texto'));
  });
});
