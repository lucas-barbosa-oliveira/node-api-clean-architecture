import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditService, type AuditRecord } from '../../src/application/audit/audit.service.ts';
import { REDACTED, redact } from '../../src/application/audit/redact.ts';
import { silentLogger } from '../../src/application/port/logger.ts';
import type { IntegrationEvent } from '../../src/application/port/event.bus.ts';
import { InMemoryEventBus } from '../../src/infrastructure/eventbus/in.memory.event.bus.ts';
import { topicMatches } from '../../src/infrastructure/eventbus/topic.ts';
import { ConsoleLogger } from '../../src/infrastructure/logger/console.logger.ts';
import { redactUri, retryUntilConnected } from '../../src/infrastructure/resilience/retry.ts';

describe('ConsoleLogger', () => {
  const capture = (level: 'info' | 'warn' | 'debug', format: 'text' | 'json' = 'text') => {
    const lines: string[] = [];
    const logger = new ConsoleLogger({ label: 'api.app', level, format, colors: false, write: line => lines.push(line) });
    return { logger, lines };
  };

  test('formato texto: rótulo @ data nível: [componente] mensagem', () => {
    const { logger, lines } = capture('info');
    logger.child('mongodb').info('Conexão estabelecida');
    assert.match(lines[0], /^api\.app @ \d{4}-\d\d-\d\dT[\d:.]+Z info: \[mongodb\] Conexão estabelecida$/);
  });

  test('respeita o nível e imprime o stack do erro', () => {
    const { logger, lines } = capture('warn');
    logger.info('não aparece');
    logger.debug('não aparece');
    logger.error('falhou', { err: new Error('boom') });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /error: falhou\nError: boom\n\s+at /);
  });

  test('formato json: uma linha por log com os campos extras', () => {
    const { logger, lines } = capture('info', 'json');
    logger.child('http').info('ok', { request_id: 'abc' });
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.label, 'api.app');
    assert.equal(entry.level, 'info');
    assert.equal(entry.component, 'http');
    assert.equal(entry.request_id, 'abc');
  });
});

describe('retryUntilConnected', () => {
  test('tenta de novo até conseguir e registra cada falha', async () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (m: string) => { warnings.push(m); } };
    let calls = 0;
    const value = await retryUntilConnected(async () => {
      if (++calls < 3) throw new Error('ECONNREFUSED');
      return 'ok';
    }, { name: 'Banco', logger, initialDelayMs: 1 });
    assert.equal(value, 'ok');
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /Falha ao conectar a Banco \(tentativa 2\): ECONNREFUSED/);
  });

  test('para quando o sinal é abortado', async () => {
    const controller = new AbortController();
    const attempt = retryUntilConnected(async () => { throw new Error('fora do ar'); }, {
      name: 'Banco', logger: new ConsoleLogger({ label: 't', level: 'silent', format: 'text' }), initialDelayMs: 10_000, signal: controller.signal,
    });
    controller.abort(new Error('SIGTERM'));
    await assert.rejects(attempt, /SIGTERM/);
  });

  test('redactUri esconde usuário e senha', () => {
    assert.equal(redactUri('amqp://app:segredo@rabbitmq:5672/vh'), 'amqp://***@rabbitmq:5672/vh');
    assert.equal(redactUri('mongodb://127.0.0.1:27017'), 'mongodb://127.0.0.1:27017');
  });
});

describe('topicMatches (exchange topic)', () => {
  test('* casa uma palavra e # casa zero ou mais', () => {
    assert.ok(topicMatches('users.delete', 'users.delete'));
    assert.ok(!topicMatches('users.delete', 'users.deleted'));
    assert.ok(topicMatches('users.*', 'users.delete'));
    assert.ok(!topicMatches('users.*', 'users.delete.now'));
    assert.ok(topicMatches('users.#', 'users'));
    assert.ok(topicMatches('users.#', 'users.delete.now'));
    assert.ok(topicMatches('#.delete', 'users.delete'));
    assert.ok(!topicMatches('users.delete', 'usersXdelete'));
  });
});

describe('InMemoryEventBus', () => {
  test('entrega aos subscribers da exchange e routing key, e responde RPC', async () => {
    const bus = new InMemoryEventBus({ service: 'api' });
    const received: IntegrationEvent[] = [];
    bus.subscribe({ eventName: 'UserDeleteEvent', exchange: 'users', routingKey: 'users.*', handle: async e => { received.push(e); } });
    bus.provideResource({ name: 'sum', handle: async (a, b) => Number(a) + Number(b) });

    await bus.publish('users', 'users.delete', { event_name: 'UserDeleteEvent', timestamp: new Date().toISOString() });
    await bus.publish('jobs', 'users.delete', { event_name: 'UserDeleteEvent', timestamp: new Date().toISOString() });
    await bus.drain();

    assert.equal(received.length, 1);
    assert.equal(await bus.executeResource('api', 'sum', 2, 3), 5);
    await assert.rejects(bus.executeResource('outro-servico', 'sum'), /indisponível/);
  });
});

describe('Auditoria', () => {
  const record = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
    requestId: 'req-1',
    actor: { id: 'u1', role: 'client', sessionId: 's1' },
    request: {
      method: 'POST',
      path: '/devices/claim',
      route: '/devices/claim',
      params: {},
      query: {},
      body: { code: 'ABCD-EFGH', name: 'ESP32', nested: { password: 'x', refresh_token: 'y' } },
      ip: '10.0.0.1',
      userAgent: 'esp32',
    },
    response: { statusCode: 201, body: { access_token: 'jwt', device_id: 'd1' } },
    startedAt: new Date('2026-11-17T10:00:00.000Z'),
    finishedAt: new Date('2026-11-17T10:00:00.250Z'),
    ...overrides,
  });
  const service = (maxBodyBytes = 16_384) =>
    new AuditService({ bus: new InMemoryEventBus({ service: 'api' }), service: 'api', maxBodyBytes });

  test('monta o RequestAuditEvent com quem, quando, entrada e resposta, sem segredos', () => {
    const event = service().toEvent(record());
    const audit = event.audit as Record<string, any>;
    assert.equal(event.event_name, 'RequestAuditEvent');
    assert.deepEqual(audit.actor, { id: 'u1', role: 'client', session_id: 's1' });
    assert.equal(audit.request_id, 'req-1');
    assert.equal(audit.duration_ms, 250);
    assert.deepEqual(audit.request.body, { code: REDACTED, name: 'ESP32', nested: { password: REDACTED, refresh_token: REDACTED } });
    assert.deepEqual(audit.response.body, { access_token: REDACTED, device_id: 'd1' });
  });

  test('em respostas de erro, "code" é o código do erro e não é escondido', () => {
    const event = service().toEvent(record({ response: { statusCode: 404, body: { code: 'NOT_FOUND', message: 'x' } } }));
    assert.deepEqual((event.audit as any).response.body, { code: 'NOT_FOUND', message: 'x' });
  });

  test('corpo grande vira só o tamanho', () => {
    const event = service(50).toEvent(record({ response: { statusCode: 200, body: Array.from({ length: 100 }, (_, i) => ({ i })) } }));
    assert.equal((event.audit as any).response.body._truncated, true);
  });

  test('redact percorre arrays e não altera o original', () => {
    const original = [{ token: 'a', keep: 1 }];
    assert.deepEqual(redact(original), [{ token: REDACTED, keep: 1 }]);
    assert.equal(original[0].token, 'a');
  });
});
