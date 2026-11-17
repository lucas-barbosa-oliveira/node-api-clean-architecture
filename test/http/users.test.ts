import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createUser, loginAsAdmin, makeApp, type TestUser } from '../helpers/make.app.ts';

// e-mails únicos: a mesma suíte roda contra memória ou Mongo sem colidir com dados anteriores
const uniqueEmail = () => `${crypto.randomUUID()}@teste.com`;
const newUserBody = (role = 'client') => ({ name: 'Ana', email: uniqueEmail(), password: 'senha-forte', role });

describe('Users API', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let adminToken: string;
  let manager: TestUser;
  let client: TestUser;

  before(async () => {
    ctx = await makeApp();
    adminToken = await loginAsAdmin(ctx.app);
    manager = await createUser(ctx.app, adminToken, 'manager');
    client = await createUser(ctx.app, adminToken, 'client');
  });
  after(() => ctx.close());

  const asAdmin = () => request(ctx.app).post('/users').auth(adminToken, { type: 'bearer' });

  test('admin cadastra gestor e cliente; e-mail normalizado e senha nunca exposta', async () => {
    const email = uniqueEmail();
    const res = await asAdmin().send({ name: ' Ana ', email: email.toUpperCase(), password: 'senha-forte', role: 'manager' });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.name, 'Ana');
    assert.equal(res.body.email, email);
    assert.equal(res.body.role, 'manager');
    assert.equal(res.body.password, undefined);
    assert.equal(res.body.passwordHash, undefined);
    assert.ok(res.body.createdAt && res.body.updatedAt);

    assert.equal((await asAdmin().send(newUserBody('client'))).status, 201);
  });

  test('gestor e cliente não podem cadastrar usuários (403)', async () => {
    for (const user of [manager, client]) {
      const res = await request(ctx.app).post('/users').auth(user.token, { type: 'bearer' }).send(newUserBody());
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'FORBIDDEN');
    }
  });

  test('não é possível cadastrar outro administrador pela API (400)', async () => {
    const res = await asAdmin().send(newUserBody('admin'));
    assert.equal(res.status, 400);
  });

  test('POST /users rejeita e-mail duplicado com 409', async () => {
    const body = newUserBody();
    assert.equal((await asAdmin().send(body)).status, 201);
    const res = await asAdmin().send(body);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'CONFLICT');
  });

  test('POST /users valida o corpo com 400', async () => {
    const res = await asAdmin().send({ name: 'A', email: 'x', password: '123', role: 'chefe' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION');
    assert.ok(Array.isArray(res.body.issues) && res.body.issues.length >= 4);
  });

  test('POST /users com JSON malformado responde 400', async () => {
    const res = await asAdmin().set('Content-Type', 'application/json').send('{ quebrado');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'BAD_REQUEST');
  });

  test('GET /users/me devolve o próprio usuário', async () => {
    const res = await request(ctx.app).get('/users/me').auth(client.token, { type: 'bearer' });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, client.id);
    assert.equal(res.body.role, 'client');
  });

  test('GET /users/:id: cada um só vê o próprio id; o de outra pessoa responde 404', async () => {
    const own = await request(ctx.app).get(`/users/${client.id}`).auth(client.token, { type: 'bearer' });
    assert.equal(own.status, 200);

    const other = await request(ctx.app).get(`/users/${manager.id}`).auth(client.token, { type: 'bearer' });
    assert.equal(other.status, 404);
    assert.equal(other.body.code, 'NOT_FOUND');
  });

  test('GET /users/:id: admin vê qualquer usuário; inexistente responde 404', async () => {
    const res = await request(ctx.app).get(`/users/${manager.id}`).auth(adminToken, { type: 'bearer' });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'manager');

    const missing = await request(ctx.app).get(`/users/${crypto.randomUUID()}`).auth(adminToken, { type: 'bearer' });
    assert.equal(missing.status, 404);
  });

  test('GET /clients: gestor lista clientes; cliente não pode (403)', async () => {
    const res = await request(ctx.app).get(`/clients?email=${client.email}`).auth(manager.token, { type: 'bearer' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((user: { id: string }) => user.id), [client.id]);
    const all = await request(ctx.app).get('/clients?limit=100').auth(manager.token, { type: 'bearer' });
    assert.ok(all.body.every((user: { role: string }) => user.role === 'client'));
    // ?role=manager não escapa do filtro de clientes
    const managers = await request(ctx.app).get(`/clients?email=${manager.email}&role=manager`).auth(manager.token, { type: 'bearer' });
    assert.equal(managers.headers['x-total-count'], '0');

    assert.equal((await request(ctx.app).get('/clients').auth(client.token, { type: 'bearer' })).status, 403);
  });

  test('GET /users (admin) aceita busca, filtro e campos; nunca expõe nem filtra pelo hash da senha', async () => {
    const res = await request(ctx.app)
      .get(`/users?email=${manager.email}&role=manager&fields=name,role`)
      .auth(adminToken, { type: 'bearer' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ id: manager.id, name: 'Usuário manager', role: 'manager' }]);

    const search = await request(ctx.app).get('/users?name=*USUARIO*&limit=1').auth(adminToken, { type: 'bearer' });
    assert.equal(search.body.length, 1);
    assert.ok(Number(search.headers['x-total-count']) >= 2);

    const hash = await request(ctx.app).get('/users?passwordHash=*a*').auth(adminToken, { type: 'bearer' });
    assert.equal(hash.status, 400);
  });

  test('GET /users é só para admin (403)', async () => {
    assert.equal((await request(ctx.app).get('/users').auth(manager.token, { type: 'bearer' })).status, 403);
  });
});
