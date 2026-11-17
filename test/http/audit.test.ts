import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import type { IntegrationEvent } from '../../src/application/port/event.bus.ts';
import { InMemoryEventBus } from '../../src/infrastructure/eventbus/in.memory.event.bus.ts';
import { registerEventBus } from '../../src/presentation/eventbus/index.ts';
import { ADMIN, createUser, loginAsAdmin, makeApp } from '../helpers/make.app.ts';
import { waitUntil } from '../helpers/wait.until.ts';

// barramento em memória mesmo no test:docker: o teste lê os eventos publicados
describe('Auditoria e RPC pelo barramento', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let bus: InMemoryEventBus;
  const events: IntegrationEvent[] = [];
  const audits = () => events.map(event => event.audit as Record<string, any>);

  before(async () => {
    ctx = await makeApp({ EVENT_BUS_DRIVER: 'memory', APP_NAME: 'api-teste' });
    bus = ctx.container.eventBus as InMemoryEventBus;
    bus.subscribe({ eventName: 'RequestAuditEvent', exchange: 'audit', routingKey: 'audit.#', handle: async e => { events.push(e); } });
    registerEventBus(bus, { userService: ctx.container.userService, jobService: ctx.container.jobService });
  });
  after(() => ctx.close());

  const findAudit = async (requestId: string) => {
    await bus.drain();
    const found = await waitUntil(async () => audits().find(a => a.request_id === requestId), Boolean, 2000);
    return found as Record<string, any>;
  };

  test('login: publica a entrada e a resposta sem senha nem tokens', async () => {
    const res = await request(ctx.app).post('/auth/login').set('User-Agent', 'teste').send(ADMIN);
    assert.equal(res.status, 200);
    const requestId = res.headers['x-request-id'];
    assert.ok(requestId);

    const audit = await findAudit(requestId);
    assert.equal(audit.service, 'api-teste');
    assert.equal(audit.actor, null); // login ainda não tem usuário autenticado
    assert.deepEqual(audit.request.body, { email: ADMIN.email, password: '[REDACTED]' });
    assert.equal(audit.response.status_code, 200);
    assert.equal(audit.response.body.access_token, '[REDACTED]');
    assert.equal(audit.response.body.refresh_token, '[REDACTED]');
    assert.equal(audit.request.user_agent, 'teste');
    assert.ok(audit.duration_ms >= 0);
  });

  test('rota autenticada: registra quem fez e o padrão da rota; o X-Request-ID do Kong é reaproveitado', async () => {
    const token = await loginAsAdmin(ctx.app);
    const res = await request(ctx.app)
      .get(`/users/${crypto.randomUUID()}`)
      .set('X-Request-ID', 'kong-req-123')
      .auth(token, { type: 'bearer' });
    assert.equal(res.status, 404);
    assert.equal(res.headers['x-request-id'], 'kong-req-123');

    const audit = await findAudit('kong-req-123');
    assert.equal(audit.actor.role, 'admin');
    assert.ok(audit.actor.session_id);
    assert.equal(audit.request.route, '/users/:id');
    assert.deepEqual(audit.response.body, { code: 'NOT_FOUND', message: 'Usuário não encontrado' });
  });

  test('requisição recusada (401) também é auditada; /health não', async () => {
    const denied = await request(ctx.app).get('/jobs');
    assert.equal(denied.status, 401);
    const audit = await findAudit(denied.headers['x-request-id']);
    assert.equal(audit.response.status_code, 401);

    const health = await request(ctx.app).get('/health');
    await bus.drain();
    assert.ok(!audits().some(a => a.request_id === health.headers['x-request-id']));
  });

  test('recursos RPC: users.find aceita a query string das rotas; erros voltam como erro', async () => {
    const token = await loginAsAdmin(ctx.app);
    const client = await createUser(ctx.app, token, 'client');

    const clients = await bus.executeResource('api-teste', 'users.find', `?role=client&email=${client.email}`) as any[];
    assert.equal(clients.length, 1);
    assert.equal(clients[0].id, client.id);
    assert.equal(clients[0].passwordHash, undefined);

    const picked = await bus.executeResource('api-teste', 'users.find', `?email=${client.email}&fields=email`);
    assert.deepEqual(picked, [{ id: client.id, email: client.email }]);

    const one = await bus.executeResource('api-teste', 'users.findone', client.id) as any;
    assert.equal(one.email, client.email);

    await assert.rejects(bus.executeResource('api-teste', 'users.find', '?senha=1'), /inválidos/);
    await assert.rejects(bus.executeResource('api-teste', 'users.findone', crypto.randomUUID()), /não encontrado/);
  });
});
