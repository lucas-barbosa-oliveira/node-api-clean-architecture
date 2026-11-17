import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { ROLE_SCOPES } from '../../src/domain/auth/scopes.ts';
import { UnauthorizedError } from '../../src/domain/error/index.ts';
import { JwtTokenService } from '../../src/infrastructure/security/jwt.token.service.ts';
import { ScryptPasswordHasher } from '../../src/infrastructure/security/scrypt.password.hasher.ts';
import { actorFor } from '../helpers/fixtures.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { ...keys, issuer: 'emissor-teste', audience: 'api-teste', expiresInSeconds: 600 };

test('scrypt: verifica a senha certa, rejeita a errada e usa salt aleatório', async () => {
  const hasher = new ScryptPasswordHasher();
  const hash = await hasher.hash('minha-senha');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await hasher.verify('minha-senha', hash), true);
  assert.equal(await hasher.verify('outra-senha', hash), false);
  assert.notEqual(await hasher.hash('minha-senha'), hash);
  assert.equal(await hasher.verify('minha-senha', 'formato-invalido'), false);
});

test('JWT: emite e valida, devolvendo o ator com os escopos', async () => {
  const tokens = new JwtTokenService(config);
  const actor = actorFor('manager');
  const { accessToken, expiresIn } = await tokens.issue(actor);
  assert.equal(expiresIn, 600);
  assert.deepEqual(await tokens.verify(accessToken), { ...actor, scopes: [...actor.scopes] });

  const withSession = { ...actor, sessionId: crypto.randomUUID() };
  assert.equal((await tokens.verify((await tokens.issue(withSession)).accessToken)).sessionId, withSession.sessionId);
});

test('JWT: rejeita token adulterado, de outro emissor/audiência, assinado com outra chave ou expirado', async () => {
  const tokens = new JwtTokenService(config);
  const { accessToken } = await tokens.issue(actorFor('client'));

  // troca o payload mantendo a assinatura original (ex.: tentar virar admin)
  const [header, , signature] = accessToken.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'x', role: 'admin', scope: ROLE_SCOPES.admin.join(' ') })).toString('base64url');
  await assert.rejects(() => tokens.verify(`${header}.${forgedPayload}.${signature}`), UnauthorizedError);

  const otherIssuer = new JwtTokenService({ ...config, issuer: 'outro' });
  await assert.rejects(async () => tokens.verify((await otherIssuer.issue(actorFor('client'))).accessToken), UnauthorizedError);

  const otherAudience = new JwtTokenService({ ...config, audience: 'outra-api' });
  await assert.rejects(async () => tokens.verify((await otherAudience.issue(actorFor('client'))).accessToken), UnauthorizedError);

  const otherKey = new JwtTokenService({ ...config, ...generateKeyPairSync('rsa', { modulusLength: 2048 }) });
  await assert.rejects(async () => tokens.verify((await otherKey.issue(actorFor('client'))).accessToken), UnauthorizedError);

  const expired = await new SignJWT({ role: 'client', scope: 'jobs:read' })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('x').setIssuer(config.issuer).setAudience(config.audience)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
    .sign(keys.privateKey);
  await assert.rejects(() => tokens.verify(expired), UnauthorizedError);

  await assert.rejects(() => tokens.verify('nao-e-um-jwt'), UnauthorizedError);
});

test('JWT: rejeita algoritmo "none" e HS256 (só RS256 é aceito)', async () => {
  const tokens = new JwtTokenService(config);
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { sub: 'x', role: 'admin', scope: 'users:create', iss: config.issuer, aud: config.audience, exp: 9_999_999_999 };
  await assert.rejects(() => tokens.verify(`${b64({ alg: 'none' })}.${b64(claims)}.`), UnauthorizedError);

  const hs256 = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('segredo-qualquer-com-32-bytes!!!'));
  await assert.rejects(() => tokens.verify(hs256), UnauthorizedError);
});

test('JWKS publica só a chave pública', async () => {
  const { keys: [jwk] } = await new JwtTokenService(config).publicJwks() as { keys: Record<string, string>[] };
  assert.equal(jwk.kty, 'RSA');
  assert.equal(jwk.alg, 'RS256');
  assert.ok(jwk.kid && jwk.n && jwk.e);
  assert.equal(jwk.d, undefined);
});
