import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createUser, loginAsAdmin, makeApp, type TestUser } from '../helpers/make.app.ts';

describe('Refresh token e revogação', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let adminToken: string;
  let user: TestUser;

  before(async () => {
    ctx = await makeApp();
    adminToken = await loginAsAdmin(ctx.app);
    user = await createUser(ctx.app, adminToken, 'client');
  });
  after(() => ctx.close());

  const login = async () => (await request(ctx.app).post('/auth/login').set('User-Agent', 'teste-http').send({ email: user.email, password: user.password })).body;
  const refresh = (token: string) => request(ctx.app).post('/auth/refresh').send({ refresh_token: token });
  const me = (token: string) => request(ctx.app).get('/users/me').auth(token, { type: 'bearer' });

  test('login devolve access e refresh token; o refresh rotaciona e o antigo deixa de valer', async () => {
    const first = await login();
    assert.ok(first.refresh_token && first.refresh_expires_in > 0);

    const res = await refresh(first.refresh_token);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.notEqual(res.body.refresh_token, first.refresh_token);
    assert.equal((await me(res.body.access_token)).status, 200);

    // reuso do refresh token antigo: 401 e a sessão inteira cai
    assert.equal((await refresh(first.refresh_token)).status, 401);
    assert.equal((await refresh(res.body.refresh_token)).status, 401);
    assert.equal((await me(res.body.access_token)).status, 401);
  });

  test('refresh com corpo inválido responde 400; com token desconhecido, 401', async () => {
    assert.equal((await request(ctx.app).post('/auth/refresh').send({})).status, 400);
    assert.equal((await refresh('invalido')).status, 401);
  });

  test('logout invalida na hora o access token e o refresh token da sessão', async () => {
    const pair = await login();
    const res = await request(ctx.app).post('/auth/logout').auth(pair.access_token, { type: 'bearer' });
    assert.equal(res.status, 204);
    assert.equal((await me(pair.access_token)).status, 401);
    assert.equal((await refresh(pair.refresh_token)).status, 401);
  });

  test('GET /auth/sessions lista as sessões ativas e marca a atual; DELETE revoga uma delas', async () => {
    const a = await login();
    const b = await login();
    const res = await request(ctx.app).get('/auth/sessions').auth(a.access_token, { type: 'bearer' });
    assert.equal(res.status, 200);
    const current = res.body.filter((session: { current: boolean }) => session.current);
    assert.equal(current.length, 1);
    assert.equal(current[0].userAgent, 'teste-http');
    assert.ok(res.body.every((session: Record<string, unknown>) => !('refreshTokenHash' in session)));

    // o id da sessão de b está no claim "sid" do access token dele
    const sidOfB = JSON.parse(Buffer.from(b.access_token.split('.')[1], 'base64url').toString()).sid;
    assert.ok(res.body.some((session: { id: string; current: boolean }) => session.id === sidOfB && !session.current));

    const del = await request(ctx.app).delete(`/auth/sessions/${sidOfB}`).auth(a.access_token, { type: 'bearer' });
    assert.equal(del.status, 204);
    assert.equal((await me(b.access_token)).status, 401);
    assert.equal((await me(a.access_token)).status, 200);
  });

  test('não é possível revogar a sessão de outra pessoa (404)', async () => {
    const otherUser = await createUser(ctx.app, adminToken, 'manager');
    const sessions = await request(ctx.app).get('/auth/sessions').auth(otherUser.token, { type: 'bearer' });
    const res = await request(ctx.app).delete(`/auth/sessions/${sessions.body[0].id}`).auth(user.token, { type: 'bearer' });
    assert.equal(res.status, 404);
    assert.equal((await me(otherUser.token)).status, 200);
  });

  test('logout-all derruba todas as sessões do usuário', async () => {
    const a = await login();
    const b = await login();
    const res = await request(ctx.app).post('/auth/logout-all').auth(a.access_token, { type: 'bearer' });
    assert.equal(res.status, 200);
    assert.ok(res.body.revoked >= 2);
    assert.equal((await me(a.access_token)).status, 401);
    assert.equal((await me(b.access_token)).status, 401);
  });

  test('admin derruba todas as sessões de um usuário; outros papéis não podem (403)', async () => {
    const target = await createUser(ctx.app, adminToken, 'manager');
    assert.equal((await request(ctx.app).delete(`/users/${target.id}/sessions`).auth(target.token, { type: 'bearer' })).status, 403);

    const res = await request(ctx.app).delete(`/users/${target.id}/sessions`).auth(adminToken, { type: 'bearer' });
    assert.equal(res.status, 200);
    assert.equal(res.body.revoked, 1);
    assert.equal((await me(target.token)).status, 401);

    const missing = await request(ctx.app).delete(`/users/${crypto.randomUUID()}/sessions`).auth(adminToken, { type: 'bearer' });
    assert.equal(missing.status, 404);
  });
});
