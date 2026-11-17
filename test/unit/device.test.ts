import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DeviceService } from '../../src/application/service/device.service.ts';
import { PassageService } from '../../src/application/service/passage.service.ts';
import { parseTimeWindow } from '../../src/application/query/time.window.ts';
import { DEVICE_SCOPES } from '../../src/domain/auth/scopes.ts';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../../src/domain/error/index.ts';
import { PairingCode } from '../../src/domain/model/pairing.code.ts';
import { normalizePairingCode } from '../../src/domain/validator/device.validator.ts';
import { InMemoryDeviceRepository } from '../../src/infrastructure/repository/in-memory/in.memory.device.repository.ts';
import { InMemoryPairingCodeRepository } from '../../src/infrastructure/repository/in-memory/in.memory.pairing.code.repository.ts';
import { InMemoryUserRepository } from '../../src/infrastructure/repository/in-memory/in.memory.user.repository.ts';
import { JwtTokenService } from '../../src/infrastructure/security/jwt.token.service.ts';
import { toFluxPredicate } from '../../src/infrastructure/timeseries/flux.filter.ts';
import { InMemoryPassageStore } from '../../src/infrastructure/timeseries/in.memory.passage.store.ts';
import { actorFor, actorOf, listQuery, newUser } from '../helpers/fixtures.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

async function setup() {
  const users = new InMemoryUserRepository();
  const devices = new InMemoryDeviceRepository();
  const pairingCodes = new InMemoryPairingCodeRepository();
  const tokens = new JwtTokenService({ ...keys, issuer: 'i', audience: 'a', expiresInSeconds: 600 });
  const service = new DeviceService({ devices, pairingCodes, users, tokens, pairingCodeTtlSeconds: 600, deviceTokenTtlSeconds: 86_400 * 365 });
  const store = new InMemoryPassageStore();
  const passages = new PassageService(store, devices);
  const [client, otherClient, manager] = [newUser('client'), newUser('client'), newUser('manager')];
  for (const user of [client, otherClient, manager]) await users.save(user);
  return { service, passages, store, devices, pairingCodes, tokens, client, otherClient, manager };
}

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: crypto.randomUUID(),
  occurredAt: new Date().toISOString(),
  direction: 'in',
  ...overrides,
});

test('código de pareamento: formato XXXX-XXXX, sem caracteres ambíguos; aceita minúsculas e sem hífen', async () => {
  const { service, client } = await setup();
  const { code, expiresIn } = await service.createPairingCode(actorOf(client), client.id);
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(expiresIn, 600);
  assert.equal(normalizePairingCode(` ${code.toLowerCase().replace('-', ' ')} `), code.replace('-', ''));
});

test('quem gera o código: o próprio cliente ou admin; outro cliente, gestor ou id que não é cliente recebem 404', async () => {
  const { service, client, otherClient, manager } = await setup();
  assert.ok(await service.createPairingCode(actorFor('admin'), client.id));
  await assert.rejects(() => service.createPairingCode(actorOf(otherClient), client.id), NotFoundError);
  await assert.rejects(() => service.createPairingCode(actorOf(manager), client.id), NotFoundError);
  await assert.rejects(() => service.createPairingCode(actorFor('admin'), manager.id), NotFoundError);
});

test('claim: troca o código pelo id do cliente e por um token de dispositivo (só telemetry:write)', async () => {
  const { service, tokens, client } = await setup();
  const { code } = await service.createPairingCode(actorOf(client), client.id);
  const claimed = await service.claim({ code: code.toLowerCase(), name: 'Porta da sala', hardwareId: '24:6f:28:ab:cd:ef' });

  assert.equal(claimed.clientId, client.id);
  assert.equal(claimed.device.clientId, client.id);
  assert.equal(claimed.device.hardwareId, '24:6F:28:AB:CD:EF');
  assert.equal(claimed.expiresIn, 86_400 * 365);
  const actor = await tokens.verify(claimed.accessToken);
  assert.deepEqual(actor, { userId: claimed.device.id, role: 'device', scopes: [...DEVICE_SCOPES], clientId: client.id });
});

test('claim: código usado, expirado, inexistente ou malformado é recusado', async () => {
  const { service, pairingCodes, client } = await setup();
  const { code } = await service.createPairingCode(actorOf(client), client.id);
  await service.claim({ code });
  await assert.rejects(() => service.claim({ code }), UnauthorizedError);
  await assert.rejects(() => service.claim({ code: 'ABCD-EFGH' }), UnauthorizedError);
  await assert.rejects(() => service.claim({ code: '123' }), ValidationError);

  const expired = new PairingCode({ clientId: client.id, codeHash: 'x', createdBy: client.id, expiresAt: new Date(Date.now() - 1000) });
  await pairingCodes.save(expired);
  assert.equal(await pairingCodes.consume('x', crypto.randomUUID()), null);
});

test('claim: dois dispositivos com o mesmo código ao mesmo tempo, só um consegue', async () => {
  const { service, client } = await setup();
  const { code } = await service.createPairingCode(actorOf(client), client.id);
  const results = await Promise.allSettled([service.claim({ code }), service.claim({ code })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('repareamento do mesmo hardware revoga o registro anterior', async () => {
  const { service, devices, client } = await setup();
  const first = await service.claim({ code: (await service.createPairingCode(actorOf(client), client.id)).code, hardwareId: 'AA:BB:CC:DD:EE:FF' });
  const second = await service.claim({ code: (await service.createPairingCode(actorOf(client), client.id)).code, hardwareId: 'AA:BB:CC:DD:EE:FF' });
  assert.equal((await devices.findById(first.device.id))?.status, 'revoked');
  assert.equal((await devices.findById(second.device.id))?.status, 'active');
  assert.equal(await service.isActive(first.device.id, client.id), false);
  assert.equal(await service.isActive(second.device.id, client.id), true);
  assert.equal(await service.isActive(second.device.id, crypto.randomUUID()), false);
});

test('dispositivos: cliente lista e revoga só os próprios (alheio dá 404); admin vê todos', async () => {
  const { service, client, otherClient } = await setup();
  const mine = await service.claim({ code: (await service.createPairingCode(actorOf(client), client.id)).code });
  await service.claim({ code: (await service.createPairingCode(actorOf(otherClient), otherClient.id)).code });

  assert.deepEqual((await service.list(actorOf(client), listQuery())).items.map(d => d.id), [mine.device.id]);
  assert.equal((await service.list(actorFor('admin'), listQuery())).total, 2);
  await assert.rejects(() => service.revoke(actorOf(otherClient), mine.device.id), NotFoundError);
  await service.revoke(actorOf(client), mine.device.id);
  assert.equal(await service.isActive(mine.device.id, client.id), false);
});

test('ingestão: dispositivo, clientId do payload e validação dos eventos', async () => {
  const { service, passages, devices, client, otherClient } = await setup();
  const { device } = await service.claim({ code: (await service.createPairingCode(actorOf(client), client.id)).code });
  const actor = { userId: device.id, role: 'device' as const, scopes: DEVICE_SCOPES, clientId: client.id };
  const repeated = event();

  const result = await passages.ingest(actor, device.id, {
    clientId: client.id,
    events: [repeated, repeated, event({ direction: 'out', sequence: 7 })],
    device: { firmware: '1.2.0', rssi: -60, uptimeSeconds: 10 },
  });
  assert.deepEqual(result, { accepted: 2 });
  const seen = await devices.findById(device.id);
  assert.ok(seen?.lastSeenAt);
  assert.equal(seen?.firmware, '1.2.0');

  // reenvio do mesmo evento não duplica
  await passages.ingest(actor, device.id, { clientId: client.id, events: [repeated] });
  assert.equal((await passages.list(actorOf(client), listQuery({ sort: { occurredAt: -1 } }))).total, 2);

  await assert.rejects(() => passages.ingest(actor, crypto.randomUUID(), { clientId: client.id, events: [event()] }), ForbiddenError);
  await assert.rejects(() => passages.ingest(actor, device.id, { clientId: otherClient.id, events: [event()] }), ForbiddenError);
  await assert.rejects(() => passages.ingest(actorOf(client), device.id, { clientId: client.id, events: [event()] }), ForbiddenError);

  const future = new Date(Date.now() + 3_600_000).toISOString();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  for (const bad of [
    { clientId: client.id, events: [] },
    { clientId: client.id, events: [event({ occurredAt: future })] },
    { clientId: client.id, events: [event({ occurredAt: old })] },
    { clientId: client.id, events: [event({ occurredAt: '2026-11-16 10:00' })] },
    { clientId: client.id, events: [event({ direction: 'lado' })] },
    { clientId: client.id, events: [event({ eventId: '1' })] },
    { clientId: 'nao-uuid', events: [event()] },
  ]) {
    await assert.rejects(() => passages.ingest(actor, device.id, bad), ValidationError, JSON.stringify(bad));
  }
});

test('consulta e resumo: cliente só vê as próprias passagens; janelas com zero onde não houve evento', async () => {
  const { service, passages, client, otherClient } = await setup();
  const mine = await service.claim({ code: (await service.createPairingCode(actorOf(client), client.id)).code });
  const theirs = await service.claim({ code: (await service.createPairingCode(actorOf(otherClient), otherClient.id)).code });
  const deviceActor = (d: typeof mine) => ({ userId: d.device.id, role: 'device' as const, scopes: DEVICE_SCOPES, clientId: d.clientId });

  const hour = 3_600_000;
  const base = Math.floor(Date.now() / hour) * hour - 3 * hour; // início de uma hora, 3h atrás
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();
  await passages.ingest(deviceActor(mine), mine.device.id, {
    clientId: client.id,
    events: [event({ occurredAt: at(60_000) }), event({ occurredAt: at(120_000) }), event({ occurredAt: at(2 * hour + 1000), direction: 'out' })],
  });
  await passages.ingest(deviceActor(theirs), theirs.device.id, { clientId: otherClient.id, events: [event({ occurredAt: at(60_000) })] });

  const query = listQuery({ filter: { occurredAt: { $gte: new Date(base), $lt: new Date(base + 3 * hour) } } });
  const summary = await passages.summarize(actorOf(client), query, parseTimeWindow('1h'));
  assert.deepEqual(summary.map(w => [w.start.getTime() - base, w.in, w.out]), [[0, 2, 0], [hour, 0, 0], [2 * hour, 0, 1]]);

  assert.equal((await passages.list(actorOf(client), listQuery())).total, 3);
  assert.equal((await passages.list(actorOf(otherClient), listQuery())).total, 1);
  assert.equal((await passages.list(actorFor('admin'), listQuery())).total, 4);
  // filtrar pelo dispositivo de outro cliente não amplia o acesso
  assert.equal((await passages.list(actorOf(client), listQuery({ filter: { deviceId: theirs.device.id } }))).total, 0);

  await assert.rejects(() => passages.summarize(actorOf(client), listQuery({ filter: { occurredAt: { $gte: new Date(0) } } }), parseTimeWindow('1m')), ValidationError);
});

test('janela de tempo: formatos aceitos e limites', () => {
  assert.deepEqual(parseTimeWindow('15m'), { every: '15m', ms: 900_000 });
  assert.deepEqual(parseTimeWindow(undefined), { every: '1h', ms: 3_600_000 });
  for (const bad of ['0m', '1s', '32d', 'abc', '1h; drop']) assert.throws(() => parseTimeWindow(bad), ValidationError, bad);
});

test('filtro -> predicado Flux: colunas, operadores e escape de strings', () => {
  assert.equal(toFluxPredicate({}), 'true');
  assert.equal(
    toFluxPredicate({ clientId: 'c1', $or: [{ direction: 'in' }, { direction: 'out' }] }),
    'r.clientId == "c1" and (r.direction == "in" or r.direction == "out")',
  );
  assert.equal(
    toFluxPredicate({ occurredAt: { $gte: new Date('2026-10-01T00:00:00Z'), $lt: new Date('2026-11-01T00:00:00Z') } }),
    'r._time >= time(v: "2026-10-01T00:00:00.000Z") and r._time < time(v: "2026-11-01T00:00:00.000Z")',
  );
  assert.equal(toFluxPredicate({ deviceId: 'x") or true or ("' }), 'r.deviceId == "x\\") or true or (\\""');
  assert.throws(() => toFluxPredicate({ eventId: 'x' }), ValidationError);
  assert.throws(() => toFluxPredicate({ deviceId: { $regex: '.*' } }), ValidationError);
});
