import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { AuthService } from '../../src/application/service/auth.service.ts';
import { ROLE_SCOPES } from '../../src/domain/auth/scopes.ts';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../src/domain/error/index.ts';
import { User } from '../../src/domain/model/user.ts';
import { InMemorySessionRepository } from '../../src/infrastructure/repository/in-memory/in.memory.session.repository.ts';
import { InMemoryUserRepository } from '../../src/infrastructure/repository/in-memory/in.memory.user.repository.ts';
import { JwtTokenService } from '../../src/infrastructure/security/jwt.token.service.ts';
import { RefreshTokenCodec } from '../../src/infrastructure/security/refresh.token.codec.ts';
import { ScryptPasswordHasher } from '../../src/infrastructure/security/scrypt.password.hasher.ts';
import { actorFor } from '../helpers/fixtures.ts';
import { makeMfa, tokensOf } from '../helpers/mfa.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

async function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const hasher = new ScryptPasswordHasher();
  const tokens = new JwtTokenService({ ...keys, issuer: 'i', audience: 'a', expiresInSeconds: 600 });
  const { mfa, mfaChallenges } = makeMfa(users, sessions);
  const auth = new AuthService({ users, sessions, hasher, tokens, refreshTokens: new RefreshTokenCodec(), refreshTtlSeconds: 3600, mfa, mfaChallenges });
  const user = User.create({ name: 'Gestor', email: 'gestor@x.com', role: 'manager', passwordHash: await hasher.hash('senha-gestor') });
  await users.save(user);
  const login = async () => tokensOf(await auth.login({ email: 'gestor@x.com', password: 'senha-gestor' }, { userAgent: 'teste', ip: '10.0.0.1' }));
  return { auth, users, sessions, user, login };
}

const isUnauthorized = (err: unknown) => err instanceof UnauthorizedError;

test('refresh token: formato opaco, só o hash é guardado e a comparação rejeita outro segredo', () => {
  const codec = new RefreshTokenCodec();
  const sessionId = crypto.randomUUID();
  const { token, hash } = codec.create(sessionId);
  assert.ok(token.startsWith(`${sessionId}.`));
  assert.ok(!hash.includes(token.split('.')[1]));
  const parsed = codec.parse(token);
  assert.equal(parsed?.sessionId, sessionId);
  assert.equal(codec.matches(parsed!.secretHash, hash), true);
  assert.equal(codec.matches(codec.parse(codec.create(sessionId).token)!.secretHash, hash), false);
  for (const bad of ['', 'abc', `${sessionId}.curto`, `nao-uuid.${'a'.repeat(43)}`, `${token}.extra`]) assert.equal(codec.parse(bad), null);
});

test('login: devolve access + refresh token e abre uma sessão; o access token carrega o sid', async () => {
  const { auth, sessions, user, login } = await setup();
  const pair = await login();
  assert.equal(pair.tokenType, 'Bearer');
  assert.equal(pair.expiresIn, 600);
  assert.ok(pair.refreshExpiresIn > 3500 && pair.refreshExpiresIn <= 3600);

  const actor = await auth.authenticate(pair.accessToken);
  assert.equal(actor.userId, user.id);
  assert.deepEqual(actor.scopes, ROLE_SCOPES.manager);

  const session = await sessions.findById(actor.sessionId!);
  assert.equal(session?.userId, user.id);
  assert.equal(session?.userAgent, 'teste');
  assert.equal(session?.ip, '10.0.0.1');
  assert.equal(JSON.parse(JSON.stringify(session)).refreshTokenHash, undefined);
});

test('login: senha errada e e-mail inexistente dão o mesmo erro; corpo inválido dá 400', async () => {
  const { auth } = await setup();
  const wrongPassword = await auth.login({ email: 'gestor@x.com', password: 'errada' }).catch(err => err);
  const unknownEmail = await auth.login({ email: 'nao@existe.com', password: 'errada' }).catch(err => err);
  assert.ok(isUnauthorized(wrongPassword) && isUnauthorized(unknownEmail));
  assert.equal(wrongPassword.message, unknownEmail.message);
  await assert.rejects(() => auth.login({ email: 'x' }), ValidationError);
});

test('refresh: rotaciona (novo refresh token a cada uso) e mantém a mesma sessão', async () => {
  const { auth, login } = await setup();
  const first = await login();
  const second = await auth.refresh({ refresh_token: first.refreshToken });
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(second.refreshToken.split('.')[0], first.refreshToken.split('.')[0]);
  assert.equal((await auth.authenticate(second.accessToken)).sessionId, (await auth.authenticate(first.accessToken)).sessionId);
  const third = await auth.refresh({ refresh_token: second.refreshToken });
  assert.ok(third.accessToken);
});

test('refresh: reusar um refresh token já usado revoga a sessão inteira (detecção de roubo)', async () => {
  const { auth, login } = await setup();
  const first = await login();
  const second = await auth.refresh({ refresh_token: first.refreshToken });

  // alguém reapresenta o token antigo (ex.: cópia vazada)
  await assert.rejects(() => auth.refresh({ refresh_token: first.refreshToken }), isUnauthorized);
  // a sessão caiu: nem o token novo nem o access token valem mais
  await assert.rejects(() => auth.refresh({ refresh_token: second.refreshToken }), isUnauthorized);
  await assert.rejects(() => auth.authenticate(second.accessToken), isUnauthorized);
});

test('refresh: dois refreshes simultâneos com o mesmo token não geram duas sessões válidas', async () => {
  const { auth, login } = await setup();
  const { refreshToken } = await login();
  const results = await Promise.allSettled([auth.refresh({ refresh_token: refreshToken }), auth.refresh({ refresh_token: refreshToken })]);
  const ok = results.filter(result => result.status === 'fulfilled');
  assert.ok(ok.length <= 1);
  for (const result of ok) {
    // quem "ganhou" também perde a sessão, porque o outro pedido foi tratado como reuso
    await assert.rejects(() => auth.authenticate((result as PromiseFulfilledResult<{ accessToken: string }>).value.accessToken), isUnauthorized);
  }
});

test('refresh: token malformado, adulterado ou de usuário removido é recusado', async () => {
  const { auth, users, user, login } = await setup();
  await assert.rejects(() => auth.refresh({}), ValidationError);
  await assert.rejects(() => auth.refresh({ refresh_token: 'lixo' }), isUnauthorized);
  await assert.rejects(() => auth.refresh({ refresh_token: `${crypto.randomUUID()}.${'a'.repeat(43)}` }), isUnauthorized);

  const { refreshToken } = await login();
  // o usuário deixou de existir (repositório novo, sem ele)
  const usersWithout = new InMemoryUserRepository();
  Object.assign(users, { findById: usersWithout.findById.bind(usersWithout) });
  await assert.rejects(() => auth.refresh({ refresh_token: refreshToken }), isUnauthorized);
  assert.ok(user);
});

test('logout: o access token deixa de valer na hora, mesmo antes de expirar', async () => {
  const { auth, login } = await setup();
  const pair = await login();
  const actor = await auth.authenticate(pair.accessToken);
  await auth.logout(actor);
  await assert.rejects(() => auth.authenticate(pair.accessToken), isUnauthorized);
  await assert.rejects(() => auth.refresh({ refresh_token: pair.refreshToken }), isUnauthorized);
});

test('logout-all e revogação pelo admin derrubam todas as sessões do usuário', async () => {
  const { auth, user, login } = await setup();
  const a = await login();
  const b = await login();
  const actor = await auth.authenticate(a.accessToken);
  assert.equal((await auth.listSessions(actor)).length, 2);

  assert.equal(await auth.logoutAll(actor), 2);
  await assert.rejects(() => auth.authenticate(b.accessToken), isUnauthorized);

  const c = await login();
  assert.equal(await auth.revokeUserSessions(user.id), 1);
  await assert.rejects(() => auth.authenticate(c.accessToken), isUnauthorized);
  await assert.rejects(() => auth.revokeUserSessions(crypto.randomUUID()), NotFoundError);
});

test('revokeSession: só a própria sessão (alheia dá 404), exceto com sessions:revoke:any', async () => {
  const { auth, login } = await setup();
  const pair = await login();
  const sessionId = (await auth.authenticate(pair.accessToken)).sessionId!;

  await assert.rejects(() => auth.revokeSession(actorFor('client'), sessionId), NotFoundError);
  await auth.revokeSession(actorFor('admin'), sessionId);
  await assert.rejects(() => auth.authenticate(pair.accessToken), isUnauthorized);
});

test('token sem sid (ex.: emitido antes das sessões) não autentica', async () => {
  const { auth, user } = await setup();
  const tokens = new JwtTokenService({ ...keys, issuer: 'i', audience: 'a', expiresInSeconds: 600 });
  const { accessToken } = await tokens.issue({ userId: user.id, role: 'manager', scopes: ROLE_SCOPES.manager });
  await assert.rejects(() => auth.authenticate(accessToken), isUnauthorized);
});

test('purge remove sessões encerradas antes da data', async () => {
  const { auth, login } = await setup();
  const pair = await login();
  await auth.logout(await auth.authenticate(pair.accessToken));
  assert.equal(await auth.purgeSessionsEndedBefore(new Date(Date.now() - 60_000)), 0);
  assert.equal(await auth.purgeSessionsEndedBefore(new Date(Date.now() + 60_000)), 1);
});
