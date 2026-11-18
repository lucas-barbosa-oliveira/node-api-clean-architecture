import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, REDACTED } from '../../src/application/audit/redact.ts';
import { AuthService, isMfaChallenge } from '../../src/application/service/auth.service.ts';
import { MfaService } from '../../src/application/service/mfa.service.ts';
import { ROLE_SCOPES } from '../../src/domain/auth/scopes.ts';
import { ConflictError, UnauthorizedError, ValidationError } from '../../src/domain/error/index.ts';
import { Session } from '../../src/domain/model/session.ts';
import { User, type UserRole } from '../../src/domain/model/user.ts';
import { InMemoryMfaChallengeRepository } from '../../src/infrastructure/repository/in-memory/in.memory.mfa.challenge.repository.ts';
import { InMemorySessionRepository } from '../../src/infrastructure/repository/in-memory/in.memory.session.repository.ts';
import { InMemoryUserRepository } from '../../src/infrastructure/repository/in-memory/in.memory.user.repository.ts';
import { AesSecretCipher } from '../../src/infrastructure/security/aes.secret.cipher.ts';
import { VaultTransitCipher } from '../../src/infrastructure/security/vault.transit.cipher.ts';
import { VaultClient } from '../../src/infrastructure/vault/vault.client.ts';
import { isDependencyUnavailable } from '../../src/infrastructure/resilience/unavailable.ts';
import { JwtTokenService } from '../../src/infrastructure/security/jwt.token.service.ts';
import { RecoveryCodes } from '../../src/infrastructure/security/recovery.codes.ts';
import { RefreshTokenCodec } from '../../src/infrastructure/security/refresh.token.codec.ts';
import { ScryptPasswordHasher } from '../../src/infrastructure/security/scrypt.password.hasher.ts';
import { base32Decode, base32Encode, hotp, Totp } from '../../src/infrastructure/security/totp.ts';
import { codeAt, tokensOf } from '../helpers/mfa.ts';

describe('TOTP (RFC 6238)', () => {
  const totp = new Totp();

  test('vetores de teste oficiais (SHA-1, 8 dígitos)', () => {
    const key = Buffer.from('12345678901234567890');
    for (const [seconds, expected] of [[59, '94287082'], [1_111_111_109, '07081804'], [1_234_567_890, '89005924'], [20_000_000_000, '65353130']] as const) {
      assert.equal(hotp(key, Math.floor(seconds / 30), 8), expected);
    }
  });

  test('base32: ida e volta, ignorando espaços, hífens e minúsculas', () => {
    const data = randomBytes(20);
    const encoded = base32Encode(data);
    assert.match(encoded, /^[A-Z2-7]{32}$/);
    assert.deepEqual(base32Decode(encoded.toLowerCase().replace(/(.{4})/g, '$1 ')), data);
    assert.throws(() => base32Decode('ABC1'), /base32/);
  });

  test('aceita ±1 passo (relógio do celular adiantado ou atrasado) e devolve o passo do código', () => {
    const secret = totp.generateSecret();
    const now = new Date();
    const step = Math.floor(now.getTime() / 30_000);
    assert.equal(totp.verify(secret, totp.codeAt(secret, now), now), step);
    assert.equal(totp.verify(secret, totp.codeAt(secret, new Date(now.getTime() - 30_000)), now), step - 1);
    assert.equal(totp.verify(secret, totp.codeAt(secret, new Date(now.getTime() + 30_000)), now), step + 1);
    const code = totp.codeAt(secret, now);
    assert.equal(totp.verify(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now), step, 'espaço no meio é aceito');
    assert.equal(totp.verify(secret, totp.codeAt(secret, new Date(now.getTime() + 90_000)), now), null);
    assert.equal(totp.verify(secret, '12345', now), null);
    assert.equal(totp.verify(secret, 'abcdef', now), null);
  });

  test('URI otpauth para o QR code', () => {
    const text = totp.keyUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'ana@x.com', issuer: 'Minha API' });
    assert.ok(text.startsWith('otpauth://totp/Minha%20API:ana%40x.com?'), text);
    const uri = new URL(text);
    assert.equal(uri.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
    assert.equal(uri.searchParams.get('issuer'), 'Minha API');
    assert.equal(uri.searchParams.get('period'), '30');
  });
});

describe('Cifra dos segredos (AES-256-GCM)', () => {
  test('ida e volta; cada cifragem é diferente; adulteração é detectada', async () => {
    const cipher = new AesSecretCipher(randomBytes(32));
    const a = await cipher.encrypt('JBSWY3DPEHPK3PXP');
    assert.notEqual(a, await cipher.encrypt('JBSWY3DPEHPK3PXP'));
    assert.ok(!a.includes('JBSWY3DPEHPK3PXP'));
    assert.equal(await cipher.decrypt(a), 'JBSWY3DPEHPK3PXP');
    const parts = a.split('.');
    parts[4] = Buffer.from('outro').toString('base64url');
    await assert.rejects(cipher.decrypt(parts.join('.')));
  });

  test('rotação: a chave anterior continua decifrando, e refresh cifra de novo com a atual', async () => {
    const oldKey = randomBytes(32);
    const sealedOld = await new AesSecretCipher(oldKey).encrypt('segredo');
    const rotated = new AesSecretCipher(randomBytes(32), [oldKey]);
    assert.equal(await rotated.decrypt(sealedOld), 'segredo');
    const refreshed = await rotated.refresh(sealedOld);
    assert.ok(refreshed && rotated.isCurrent(refreshed));
    assert.equal(await rotated.refresh(refreshed), null, 'já está com a chave atual');
    await assert.rejects(new AesSecretCipher(randomBytes(32)).decrypt(sealedOld), /chave desconhecida/);
    assert.throws(() => new AesSecretCipher(randomBytes(16)), /32 bytes/);
  });
});

describe('Cifra pelo Vault Transit', () => {
  /** Vault falso: só os endpoints do Transit que a aplicação usa, com versões de chave e rewrap. */
  async function fakeVault() {
    const keys = [randomBytes(32)];
    const seen: { path: string; token?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push({ path: req.url ?? '', token: req.headers['x-vault-token'] as string | undefined });
        const json = body ? JSON.parse(body) : {};
        const send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
        const seal = (plain: string) => `vault:v${keys.length}:${new AesSecretCipher(keys.at(-1)!).encryptSync(plain)}`;
        const open = (sealed: string) => {
          const [, version, inner] = /^vault:v(\d+):(.*)$/.exec(sealed) ?? [];
          return new AesSecretCipher(keys[Number(version) - 1]).decryptSync(inner);
        };
        if (req.url === '/v1/transit/encrypt/mfa') return send(200, { data: { ciphertext: seal(json.plaintext) } });
        if (req.url === '/v1/transit/decrypt/mfa') return send(200, { data: { plaintext: open(json.ciphertext) } });
        if (req.url === '/v1/transit/rewrap/mfa') return send(200, { data: { ciphertext: seal(open(json.ciphertext)) } });
        if (req.url === '/v1/transit/keys/mfa') return send(200, { data: { latest_version: keys.length } });
        send(403, { errors: ['permission denied'] });
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { address, keys, seen, close: () => new Promise(resolve => server.close(resolve)) };
  }

  test('cifra e decifra pelo Vault (com o token do arquivo do Agent); a chave não passa pela aplicação', async () => {
    const vault = await fakeVault();
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    writeFileSync(join(dir, 'token'), 'token-do-agent\n');
    try {
      const cipher = new VaultTransitCipher({
        vault: new VaultClient({ address: vault.address, tokenFile: join(dir, 'token') }), mount: 'transit', key: 'mfa',
      });
      const sealed = await cipher.encrypt('JBSWY3DPEHPK3PXP');
      assert.match(sealed, /^vault:v1:/);
      assert.equal(await cipher.decrypt(sealed), 'JBSWY3DPEHPK3PXP');
      assert.equal(vault.seen[0].token, 'token-do-agent');
      assert.equal(await cipher.refresh(sealed), null, 'versão atual: nada a fazer');

      vault.keys.push(randomBytes(32)); // chave rotacionada no Vault
      await cipher.latestVersion();
      const rewrapped = await cipher.refresh(sealed);
      assert.match(rewrapped ?? '', /^vault:v2:/);
      assert.equal(await cipher.decrypt(rewrapped!), 'JBSWY3DPEHPK3PXP');
    } finally {
      await vault.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migração de MFA_CIPHER=local: o formato antigo é lido com a chave local e passa para o Transit', async () => {
    const vault = await fakeVault();
    try {
      const legacy = new AesSecretCipher(randomBytes(32));
      const old = await legacy.encrypt('segredo-antigo');
      const cipher = new VaultTransitCipher({ vault: new VaultClient({ address: vault.address }), mount: 'transit', key: 'mfa', legacy });
      assert.equal(await cipher.decrypt(old), 'segredo-antigo');
      const migrated = await cipher.refresh(old);
      assert.match(migrated ?? '', /^vault:v1:/);
      await assert.rejects(
        new VaultTransitCipher({ vault: new VaultClient({ address: vault.address }), mount: 'transit', key: 'mfa' }).decrypt(old),
        /MFA_ENCRYPTION_KEY/,
      );
    } finally {
      await vault.close();
    }
  });

  test('Vault fora do ar vira VaultUnavailableError (503); permissão negada não', async () => {
    const vault = await fakeVault();
    const address = vault.address;
    await vault.close();
    const down = new VaultTransitCipher({ vault: new VaultClient({ address }), mount: 'transit', key: 'mfa' });
    await assert.rejects(down.encrypt('x'), (err: Error) => isDependencyUnavailable(err));
    const up = await fakeVault();
    try {
      const denied = new VaultTransitCipher({ vault: new VaultClient({ address: up.address }), mount: 'transit', key: 'outra' });
      await assert.rejects(denied.encrypt('x'), (err: Error) => /permission denied/.test(err.message) && !isDependencyUnavailable(err));
    } finally {
      await up.close();
    }
  });
});

describe('Códigos de recuperação', () => {
  test('formato XXXX-XXXX-XXXX-XXXX sem caracteres ambíguos, únicos e guardados só como hash', () => {
    const codes = new RecoveryCodes();
    const { codes: list, hashes } = codes.generate(10);
    assert.equal(new Set(list).size, 10);
    for (const code of list) assert.match(code, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    assert.ok(hashes.every(hash => !list.some(code => hash.includes(code))));
    assert.equal(codes.hash(list[0].toLowerCase().replaceAll('-', ' ')), hashes[0], 'minúsculas e espaços são aceitos');
    assert.equal(codes.hash('123456'), null, 'um código TOTP não é confundido com código de recuperação');
  });
});

test('auditoria: mfa_token, códigos de recuperação e a URL do QR code nunca saem', () => {
  const body = { mfa_token: 'x.y', recovery_codes: ['A'], otpauth_url: 'otpauth://...', secret: 'S', expires_in: 300 };
  assert.deepEqual(redact(body), {
    mfa_token: REDACTED, recovery_codes: REDACTED, otpauth_url: REDACTED, secret: REDACTED, expires_in: 300,
  });
});

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

async function setup(options: { role?: UserRole; requiredRoles?: UserRole[] } = {}) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const challenges = new InMemoryMfaChallengeRepository();
  const hasher = new ScryptPasswordHasher();
  const tokens = new JwtTokenService({ ...keys, issuer: 'i', audience: 'a', expiresInSeconds: 600 });
  const totp = new Totp();
  const key = randomBytes(32);
  const makeMfa = (cipher = new AesSecretCipher(key)) => new MfaService({
    users, sessions, totp, cipher, recoveryCodes: new RecoveryCodes(), issuer: 'teste', requiredRoles: options.requiredRoles,
  });
  const mfa = makeMfa();
  const auth = new AuthService({
    users, sessions, hasher, tokens, refreshTokens: new RefreshTokenCodec(), refreshTtlSeconds: 3600, mfa, mfaChallenges: challenges,
  });
  const role = options.role ?? 'manager';
  const user = User.create({ name: 'Ana', email: 'ana@x.com', role, passwordHash: await hasher.hash('senha-da-ana') });
  await users.save(user);
  const login = () => auth.login({ email: 'ana@x.com', password: 'senha-da-ana' });
  const sessionActor = async () => {
    const pair = tokensOf(await login());
    return { pair, actor: await auth.authenticate(pair.accessToken) };
  };
  /** Configura e ativa o MFA; devolve o segredo e os códigos de recuperação. */
  const enroll = async () => {
    const { actor, pair } = await sessionActor();
    const { secret } = await mfa.setup(actor);
    const { recoveryCodes } = await mfa.enable(actor, { code: totp.codeAt(secret) });
    return { secret, recoveryCodes, actor, pair };
  };
  return { auth, mfa, makeMfa, users, sessions, tokens, totp, user, key, login, sessionActor, enroll };
}

describe('MFA: configuração e login em duas etapas', () => {
  test('setup gera o segredo inativo; enable confirma, devolve 10 códigos de recuperação e status reflete', async () => {
    const { mfa, totp, sessionActor, users, user } = await setup();
    const { actor } = await sessionActor();
    const setupResult = await mfa.setup(actor);
    assert.match(setupResult.secret, /^[A-Z2-7]{32}$/);
    assert.ok(setupResult.otpauthUrl.startsWith('otpauth://totp/teste:ana%40x.com?'));
    assert.equal((await mfa.status(actor)).enabled, false, 'só liga depois de confirmar');

    await assert.rejects(mfa.enable(actor, { code: '000000' }), ValidationError);
    const { recoveryCodes } = await mfa.enable(actor, { code: totp.codeAt(setupResult.secret) });
    assert.equal(recoveryCodes.length, 10);
    assert.deepEqual(await mfa.status(actor), {
      enabled: true, enabledAt: (await users.findById(user.id))?.mfa?.enabledAt, recoveryCodesRemaining: 10, required: false,
    });
    const stored = (await users.findById(user.id))?.mfa;
    assert.ok(stored?.secret && !stored.secret.includes(setupResult.secret), 'o segredo fica cifrado no banco');
    await assert.rejects(mfa.setup(actor), ConflictError);
  });

  test('enable sem setup (ou com setup expirado) responde conflito', async () => {
    const { mfa, sessionActor } = await setup();
    const { actor } = await sessionActor();
    await assert.rejects(mfa.enable(actor, { code: '123456' }), ConflictError);
  });

  test('login com MFA: senha devolve o desafio; o código do aplicativo devolve os tokens com amr', async () => {
    const { auth, tokens, totp, login, enroll } = await setup();
    const { secret } = await enroll();
    const result = await login();
    assert.ok(isMfaChallenge(result));
    assert.deepEqual(result.methods, ['totp', 'recovery_code']);
    assert.equal(result.expiresIn, 300);

    const pair = await auth.verifyMfa({ mfa_token: result.mfaToken, code: codeAt(totp, secret, 1) });
    const actor = await tokens.verify(pair.accessToken);
    assert.deepEqual(actor.amr, ['pwd', 'otp', 'mfa']);

    // o mesmo mfa_token não vale de novo, nem o mesmo código em outro login (reuso de código interceptado)
    await assert.rejects(auth.verifyMfa({ mfa_token: result.mfaToken, code: codeAt(totp, secret, 1) }), UnauthorizedError);
    const again = await login();
    assert.ok(isMfaChallenge(again));
    await assert.rejects(auth.verifyMfa({ mfa_token: again.mfaToken, code: codeAt(totp, secret, 1) }), /Código inválido ou já usado/);
  });

  test('código de recuperação: entra uma vez e some da lista', async () => {
    const { auth, mfa, login, enroll } = await setup();
    const { recoveryCodes, actor } = await enroll();
    const challenge = await login();
    assert.ok(isMfaChallenge(challenge));
    const pair = await auth.verifyMfa({ mfa_token: challenge.mfaToken, code: recoveryCodes[0].toLowerCase() });
    assert.ok(pair.accessToken);
    assert.equal((await mfa.status(actor)).recoveryCodesRemaining, 9);

    const second = await login();
    assert.ok(isMfaChallenge(second));
    await assert.rejects(auth.verifyMfa({ mfa_token: second.mfaToken, code: recoveryCodes[0] }), UnauthorizedError);
  });

  test('cada desafio aceita 5 tentativas: depois, nem o código certo vale (só novo login)', async () => {
    const { auth, totp, login, enroll } = await setup();
    const { secret } = await enroll();
    const challenge = await login();
    assert.ok(isMfaChallenge(challenge));
    const messages = [];
    for (let i = 0; i < 5; i++) {
      messages.push((await auth.verifyMfa({ mfa_token: challenge.mfaToken, code: '000000' }).catch(err => err)).message);
    }
    assert.match(messages[0], /4 tentativa\(s\) restante/);
    assert.match(messages[4], /Faça login novamente/);
    await assert.rejects(
      auth.verifyMfa({ mfa_token: challenge.mfaToken, code: codeAt(totp, secret, 1) }),
      /sem tentativas restantes/,
    );
  });

  test('mfa_token adulterado ou inexistente: 401 sem revelar o motivo', async () => {
    const { auth } = await setup();
    await assert.rejects(auth.verifyMfa({ mfa_token: 'qualquer', code: '123456' }), UnauthorizedError);
    const fake = new RefreshTokenCodec().create(crypto.randomUUID()).token;
    await assert.rejects(auth.verifyMfa({ mfa_token: fake, code: '123456' }), UnauthorizedError);
    await assert.rejects(auth.verifyMfa({ code: '123456' }), ValidationError);
  });

  test('ativar encerra as outras sessões (abertas só com senha) e eleva a atual', async () => {
    const { auth, sessionActor, enroll } = await setup();
    const other = await sessionActor();
    const { pair } = await enroll();
    await assert.rejects(auth.authenticate(other.pair.accessToken), UnauthorizedError);
    const refreshed = await auth.refresh({ refresh_token: pair.refreshToken });
    assert.deepEqual((await auth.authenticate(refreshed.accessToken)).amr, ['pwd', 'otp', 'mfa']);
  });

  test('desativar exige código; regenerar códigos exige o do aplicativo', async () => {
    const { mfa, totp, enroll } = await setup();
    const { secret, recoveryCodes, actor } = await enroll();
    await assert.rejects(mfa.regenerateRecoveryCodes(actor, { code: recoveryCodes[0] }), ValidationError);
    const { recoveryCodes: fresh } = await mfa.regenerateRecoveryCodes(actor, { code: codeAt(totp, secret, 1) });
    assert.equal(fresh.length, 10);
    await assert.rejects(mfa.disable(actor, { code: recoveryCodes[1] }), ValidationError, 'os antigos não valem mais');
    await assert.rejects(mfa.disable(actor, { code: '000000' }), ValidationError);
    await mfa.disable(actor, { code: fresh[0] });
    assert.equal((await mfa.status(actor)).enabled, false);
    await assert.rejects(mfa.disable(actor, { code: fresh[1] }), ConflictError);
  });

  test('administrador redefine o MFA: o usuário volta a entrar só com senha e as sessões caem', async () => {
    const { auth, mfa, login, user, enroll } = await setup();
    const { pair } = await enroll();
    await mfa.reset(user.id);
    await assert.rejects(auth.authenticate(pair.accessToken), UnauthorizedError);
    assert.ok(!isMfaChallenge(await login()));
    await assert.rejects(mfa.reset(user.id), ConflictError);
  });

  test('rotação da chave: o segredo cifrado com a anterior é cifrado de novo no próximo uso', async () => {
    const { totp, login, users, user, key, enroll, makeMfa } = await setup();
    const { secret } = await enroll();
    const sealedBefore = (await users.findById(user.id))?.mfa?.secret as string;
    const rotated = new AesSecretCipher(randomBytes(32), [key]);
    const rotatedMfa = makeMfa(rotated);
    const challenge = await login();
    assert.ok(isMfaChallenge(challenge));
    const fresh = await users.findById(user.id) as User;
    assert.ok(await rotatedMfa.verifyCode(fresh, codeAt(totp, secret, 1)));
    const sealedAfter = (await users.findById(user.id))?.mfa?.secret as string;
    assert.notEqual(sealedAfter, sealedBefore);
    assert.equal(rotated.isCurrent(sealedAfter), true);
    assert.equal(await rotated.decrypt(sealedAfter), secret);
  });
});

describe('MFA obrigatório por papel (MFA_REQUIRED_ROLES)', () => {
  test('sem MFA: token sem escopos e com aviso; depois de ativar, o refresh devolve os escopos do papel', async () => {
    const { auth, mfa, totp, login } = await setup({ role: 'manager', requiredRoles: ['manager'] });
    const restricted = tokensOf(await login());
    assert.equal(restricted.mfaEnrollmentRequired, true);
    const actor = await auth.authenticate(restricted.accessToken);
    assert.deepEqual(actor.scopes, []);
    assert.equal(actor.mfaEnrollmentRequired, true);
    assert.equal((await mfa.status(actor)).required, true);

    const { secret } = await mfa.setup(actor);
    await mfa.enable(actor, { code: totp.codeAt(secret) });
    const full = await auth.refresh({ refresh_token: restricted.refreshToken });
    assert.equal(full.mfaEnrollmentRequired, undefined);
    assert.deepEqual((await auth.authenticate(full.accessToken)).scopes, ROLE_SCOPES.manager);
  });

  test('outros papéis não são afetados', async () => {
    const { auth, login } = await setup({ role: 'client', requiredRoles: ['admin'] });
    const pair = tokensOf(await login());
    assert.deepEqual((await auth.authenticate(pair.accessToken)).scopes, ROLE_SCOPES.client);
  });

  test('sessão antiga, aberta só com senha, perde os escopos no refresh quando o papel passa a exigir MFA', async () => {
    const { auth, sessions, user } = await setup({ role: 'manager', requiredRoles: ['manager'] });
    const codec = new RefreshTokenCodec();
    const id = crypto.randomUUID();
    const refresh = codec.create(id);
    await sessions.save(Session.start({ id, userId: user.id, refreshTokenHash: refresh.hash, ttlSeconds: 3600 }));
    const pair = await auth.refresh({ refresh_token: refresh.token });
    assert.equal(pair.mfaEnrollmentRequired, true);
  });
});
