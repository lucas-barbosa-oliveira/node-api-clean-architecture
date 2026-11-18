import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { Totp } from '../../src/infrastructure/security/totp.ts';
import { createUser, loginAsAdmin, makeApp } from '../helpers/make.app.ts';

const totp = new Totp();
const inSteps = (secret: string, steps: number) => totp.codeAt(secret, new Date(Date.now() + steps * 30_000));

describe('MFA pela API', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let admin: string;

  before(async () => {
    // gestores precisam de MFA; os demais papéis, não
    ctx = await makeApp({ MFA_REQUIRED_ROLES: 'manager' });
    admin = await loginAsAdmin(ctx.app);
  });
  after(() => ctx.close());

  const as = (token: string) => ({
    get: (url: string) => request(ctx.app).get(url).auth(token, { type: 'bearer' }),
    post: (url: string) => request(ctx.app).post(url).auth(token, { type: 'bearer' }),
  });

  test('cliente: ativa o MFA e passa a entrar em duas etapas; o cadastro mostra mfaEnabled', async () => {
    const user = await createUser(ctx.app, admin, 'client');
    const setup = await as(user.token).post('/auth/mfa/setup').expect(200);
    assert.equal(setup.headers['cache-control'], 'no-store');
    const enabled = await as(user.token).post('/auth/mfa/enable').send({ code: totp.codeAt(setup.body.secret) }).expect(200);
    assert.equal(enabled.body.recovery_codes.length, 10);
    assert.equal((await as(user.token).get('/users/me')).body.mfaEnabled, true);

    const first = await request(ctx.app).post('/auth/login').send({ email: user.email, password: user.password }).expect(200);
    assert.equal(first.body.mfa_required, true);
    assert.equal(first.body.access_token, undefined, 'sem tokens antes do segundo fator');
    const wrong = await request(ctx.app).post('/auth/mfa/verify').send({ mfa_token: first.body.mfa_token, code: '000000' });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.message, /4 tentativa/);

    const ok = await request(ctx.app).post('/auth/mfa/verify')
      .send({ mfa_token: first.body.mfa_token, code: inSteps(setup.body.secret, 1) }).expect(200);
    const sessions = await as(ok.body.access_token).get('/auth/sessions').expect(200);
    const current = sessions.body.find((session: { current: boolean }) => session.current);
    assert.deepEqual(current.amr, ['pwd', 'otp', 'mfa']);
  });

  test('gestor (MFA obrigatório): token restrito até ativar; depois do refresh, escopos completos', async () => {
    const manager = await createUser(ctx.app, admin, 'manager');
    const restricted = await request(ctx.app).post('/auth/login')
      .send({ email: manager.email, password: manager.password }).expect(200);
    assert.equal(restricted.body.mfa_enrollment_required, true);

    const blocked = await as(restricted.body.access_token).get('/clients');
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.message, /exige autenticação multifator/);
    assert.equal((await as(restricted.body.access_token).get('/auth/mfa')).body.required, true);

    const setup = await as(restricted.body.access_token).post('/auth/mfa/setup').expect(200);
    await as(restricted.body.access_token).post('/auth/mfa/enable').send({ code: totp.codeAt(setup.body.secret) }).expect(200);
    const full = await request(ctx.app).post('/auth/refresh').send({ refresh_token: restricted.body.refresh_token }).expect(200);
    assert.equal(full.body.mfa_enrollment_required, undefined);
    await as(full.body.access_token).get('/clients').expect(200);
  });

  test('administrador redefine o MFA de quem perdeu o celular; o usuário volta a entrar só com senha', async () => {
    const user = await createUser(ctx.app, admin, 'client');
    const setup = await as(user.token).post('/auth/mfa/setup').expect(200);
    await as(user.token).post('/auth/mfa/enable').send({ code: totp.codeAt(setup.body.secret) }).expect(200);

    await request(ctx.app).delete(`/users/${user.id}/mfa`).auth(user.token, { type: 'bearer' }).expect(403);
    await request(ctx.app).delete(`/users/${user.id}/mfa`).auth(admin, { type: 'bearer' }).expect(204);
    await as(user.token).get('/users/me').expect(401); // sessões encerradas
    const login = await request(ctx.app).post('/auth/login').send({ email: user.email, password: user.password }).expect(200);
    assert.ok(login.body.access_token);
  });
});
