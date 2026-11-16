import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp } from '../helpers/make.app.ts';

// e-mails únicos: a mesma suíte roda contra memória ou Mongo sem colidir com dados anteriores
const uniqueEmail = () => `${crypto.randomUUID()}@teste.com`;

describe('Users API', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  before(async () => { ctx = await makeApp(); });
  after(() => ctx.close());

  test('GET /health responde ok', async () => {
    const res = await request(ctx.app).get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  test('POST /users cria usuário e normaliza o e-mail', async () => {
    const email = uniqueEmail();
    const res = await request(ctx.app).post('/users').send({ name: ' Ana ', email: email.toUpperCase() });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.name, 'Ana');
    assert.equal(res.body.email, email);
    assert.ok(res.body.createdAt && res.body.updatedAt);
  });

  test('POST /users rejeita e-mail duplicado com 409', async () => {
    const payload = { name: 'Ana', email: uniqueEmail() };
    assert.equal((await request(ctx.app).post('/users').send(payload)).status, 201);
    const res = await request(ctx.app).post('/users').send(payload);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'CONFLICT');
  });

  test('POST /users valida o corpo com 400', async () => {
    const res = await request(ctx.app).post('/users').send({ name: 'A', email: 'x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION');
    assert.ok(Array.isArray(res.body.issues) && res.body.issues.length > 0);
  });

  test('POST /users com JSON malformado responde 400', async () => {
    const res = await request(ctx.app).post('/users').set('Content-Type', 'application/json').send('{ quebrado');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'BAD_REQUEST');
  });

  test('GET /users/:id retorna 404 se não existir', async () => {
    const res = await request(ctx.app).get(`/users/${crypto.randomUUID()}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
  });

  test('GET /users/:id retorna o usuário criado', async () => {
    const created = await request(ctx.app).post('/users').send({ name: 'Bia', email: uniqueEmail() });
    const res = await request(ctx.app).get(`/users/${created.body.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Bia');
  });
});
