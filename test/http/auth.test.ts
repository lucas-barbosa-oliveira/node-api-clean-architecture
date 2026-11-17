import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ADMIN, makeApp } from '../helpers/make.app.ts';

describe('Auth API', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  before(async () => { ctx = await makeApp(); });
  after(() => ctx.close());

  test('GET /health é público', async () => {
    const res = await request(ctx.app).get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('POST /auth/login devolve um access token no formato OAuth 2.0', async () => {
    const res = await request(ctx.app).post('/auth/login').send(ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.token_type, 'Bearer');
    assert.equal(typeof res.body.expires_in, 'number');
    assert.equal(res.body.access_token.split('.').length, 3);
  });

  test('POST /auth/login com senha errada ou e-mail inexistente responde 401 com a mesma mensagem', async () => {
    const wrong = await request(ctx.app).post('/auth/login').send({ ...ADMIN, password: 'errada!!' });
    const unknown = await request(ctx.app).post('/auth/login').send({ email: 'nao@existe.com', password: 'errada!!' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.message, unknown.body.message);
  });

  test('POST /auth/login valida o corpo com 400', async () => {
    const res = await request(ctx.app).post('/auth/login').send({ email: 'x' });
    assert.equal(res.status, 400);
  });

  test('rotas protegidas sem token ou com token inválido respondem 401', async () => {
    const noToken = await request(ctx.app).get('/users/me');
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.code, 'UNAUTHORIZED');
    assert.equal(noToken.headers['www-authenticate'], 'Bearer');

    const badToken = await request(ctx.app).get('/users/me').auth('a.b.c', { type: 'bearer' });
    assert.equal(badToken.status, 401);

    const basic = await request(ctx.app).get('/users/me').auth('usuario', 'senha');
    assert.equal(basic.status, 401);
  });

  test('GET /.well-known/jwks.json publica a chave pública', async () => {
    const res = await request(ctx.app).get('/.well-known/jwks.json');
    assert.equal(res.status, 200);
    assert.equal(res.body.keys[0].kty, 'RSA');
    assert.equal(res.body.keys[0].d, undefined);
  });
});
