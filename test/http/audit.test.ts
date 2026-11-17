import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
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
  const domainEvents: IntegrationEvent[] = [];
  const dbName = `audit_test_${Date.now()}`;
  const audits = () => events.map(event => event.audit as Record<string, any>);

  before(async () => {
    // banco próprio: o relay deste teste não encontra eventos pendentes deixados pelos outros testes
    ctx = await makeApp({ EVENT_BUS_DRIVER: 'memory', APP_NAME: 'api-teste', MONGO_DB: dbName });
    bus = ctx.container.eventBus as InMemoryEventBus;
    bus.subscribe({ eventName: 'RequestAuditEvent', exchange: 'audit', routingKey: 'audit.#', handle: async e => { events.push(e); } });
    for (const [eventName, exchange] of [['UserCreatedEvent', 'users'], ['DevicePairedEvent', 'devices'], ['DeviceRevokedEvent', 'devices']]) {
      bus.subscribe({ eventName, exchange, routingKey: '#', handle: async e => { domainEvents.push(e); } });
    }
    registerEventBus(bus, { userService: ctx.container.userService, jobService: ctx.container.jobService });
    bus.start();
    ctx.container.outboxRelay.start(); // a auditoria vai para o outbox; o relay publica no barramento
  });
  after(async () => {
    await ctx.close();
    if (process.env.REPOSITORY_DRIVER === 'mongo') {
      const connection = await mongoose.createConnection(process.env.MONGO_URI as string, { dbName }).asPromise();
      await connection.dropDatabase();
      await connection.close();
    }
  });

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

  test('eventos de domínio saem pelo outbox: usuário criado, dispositivo pareado e revogado', async () => {
    const token = await loginAsAdmin(ctx.app);
    const client = await createUser(ctx.app, token, 'client');
    const code = await request(ctx.app).post(`/clients/${client.id}/pairing-codes`).auth(client.token, { type: 'bearer' }).expect(201);
    const hardwareId = '24:6F:28:00:00:01';
    const first = await request(ctx.app).post('/devices/claim').send({ code: code.body.code, hardwareId }).expect(201);
    // o mesmo hardware pareado de novo revoga o registro anterior
    const code2 = await request(ctx.app).post(`/clients/${client.id}/pairing-codes`).auth(client.token, { type: 'bearer' }).expect(201);
    await request(ctx.app).post('/devices/claim').send({ code: code2.body.code, hardwareId }).expect(201);

    const of = (name: string) => domainEvents.filter(e => e.event_name === name);
    await waitUntil(async () => of('DeviceRevokedEvent').length, n => n >= 1, 3000);
    const created = of('UserCreatedEvent').find(e => (e.user as { id: string }).id === client.id) as Record<string, any>;
    assert.equal(created.user.email, client.email);
    assert.equal(created.user.passwordHash, undefined);
    assert.ok(of('DevicePairedEvent').some(e => (e.device as { id: string }).id === first.body.device_id));
    const revoked = of('DeviceRevokedEvent').find(e => (e.device as { id: string }).id === first.body.device_id) as Record<string, any>;
    assert.equal(revoked.reason, 'replaced_by_new_pairing');
    assert.equal(revoked.device.status, 'revoked');
  });
});
