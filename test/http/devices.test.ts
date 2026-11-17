import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createUser, loginAsAdmin, makeApp, type TestUser } from '../helpers/make.app.ts';

describe('Dispositivos (ESP32) e passagens', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let adminToken: string;
  let client: TestUser;
  let otherClient: TestUser;
  let manager: TestUser;

  before(async () => {
    ctx = await makeApp();
    adminToken = await loginAsAdmin(ctx.app);
    [client, otherClient, manager] = await Promise.all([
      createUser(ctx.app, adminToken, 'client'),
      createUser(ctx.app, adminToken, 'client'),
      createUser(ctx.app, adminToken, 'manager'),
    ]);
  });
  after(() => ctx.close());

  const newCode = async (token: string, clientId: string) =>
    request(ctx.app).post(`/clients/${clientId}/pairing-codes`).auth(token, { type: 'bearer' });
  const claim = (code: string, extra: object = {}) => request(ctx.app).post('/devices/claim').send({ code, name: 'Porta da sala', ...extra });
  const pair = async (user: TestUser) => (await claim((await newCode(user.token, user.id)).body.code)).body;
  const send = (device: { device_id: string; access_token: string }, body: object) =>
    request(ctx.app).post(`/devices/${device.device_id}/passages`).auth(device.access_token, { type: 'bearer' }).send(body);
  const event = (overrides: object = {}) => ({ eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), direction: 'in', ...overrides });

  test('cliente gera o código; a ESP32 troca pelo id do cliente e pelo token', async () => {
    const created = await newCode(client.token, client.id);
    assert.equal(created.status, 201);
    assert.equal(created.headers['cache-control'], 'no-store');
    assert.match(created.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(created.body.expires_in, 600);

    const res = await claim(created.body.code, { hardwareId: '24:6F:28:AB:CD:01', firmware: '1.0.0' });
    assert.equal(res.status, 201);
    assert.equal(res.body.client_id, client.id);
    assert.ok(res.body.device_id && res.body.access_token);
    assert.equal(res.body.token_type, 'Bearer');

    assert.equal((await claim(created.body.code)).status, 401); // uso único
  });

  test('permissões para gerar código: outro cliente e gestor não podem; admin pode', async () => {
    assert.equal((await newCode(otherClient.token, client.id)).status, 404);
    assert.equal((await newCode(manager.token, manager.id)).status, 403);
    assert.equal((await newCode(adminToken, client.id)).status, 201);
  });

  test('envio de passagens: 202, idempotente, e o clientId precisa ser o do dispositivo', async () => {
    const device = await pair(client);
    const repeated = event();
    const ok = await send(device, { clientId: device.client_id, events: [repeated, event({ direction: 'out', sequence: 2 })], device: { rssi: -55 } });
    assert.equal(ok.status, 202);
    assert.deepEqual(ok.body, { accepted: 2 });
    assert.equal((await send(device, { clientId: device.client_id, events: [repeated] })).status, 202);

    const list = await request(ctx.app).get(`/passages?deviceId=${device.device_id}`).auth(client.token, { type: 'bearer' });
    assert.equal(list.status, 200);
    assert.equal(list.headers['x-total-count'], '2');
    assert.deepEqual(list.body.map((p: { direction: string }) => p.direction).sort(), ['in', 'out']);
    assert.ok(list.body.every((p: { clientId: string; receivedAt: string }) => p.clientId === client.id && p.receivedAt));

    const wrongClient = await send(device, { clientId: otherClient.id, events: [event()] });
    assert.equal(wrongClient.status, 403);
    const invalid = await send(device, { clientId: device.client_id, events: [event({ occurredAt: 'ontem' })] });
    assert.equal(invalid.status, 400);
  });

  test('o token do dispositivo só serve para enviar dados do próprio dispositivo', async () => {
    const device = await pair(client);
    const other = await pair(client);
    const asOther = await request(ctx.app)
      .post(`/devices/${other.device_id}/passages`).auth(device.access_token, { type: 'bearer' })
      .send({ clientId: client.id, events: [event()] });
    assert.equal(asOther.status, 403);
    for (const path of ['/jobs', '/users/me', '/passages', '/devices']) {
      assert.equal((await request(ctx.app).get(path).auth(device.access_token, { type: 'bearer' })).status, 403, path);
    }
    // e token de usuário não envia dados
    const asUser = await request(ctx.app)
      .post(`/devices/${device.device_id}/passages`).auth(client.token, { type: 'bearer' })
      .send({ clientId: client.id, events: [event()] });
    assert.equal(asUser.status, 403);
  });

  test('consulta com query string e resumo por janela; outro cliente não vê os dados', async () => {
    const device = await pair(client);
    const hour = 3_600_000;
    const base = Math.floor(Date.now() / hour) * hour - 2 * hour;
    await send(device, {
      clientId: client.id,
      events: [
        event({ occurredAt: new Date(base + 1000).toISOString() }),
        event({ occurredAt: new Date(base + 2000).toISOString(), direction: 'out' }),
        event({ occurredAt: new Date(base + hour + 1000).toISOString() }),
      ],
    });
    const get = (path: string, token = client.token) => request(ctx.app).get(path).auth(token, { type: 'bearer' });

    const onlyIn = await get(`/passages?deviceId=${device.device_id}&direction=in&sort=occurredAt&fields=direction,occurredAt`);
    assert.equal(onlyIn.headers['x-total-count'], '2');
    assert.deepEqual(Object.keys(onlyIn.body[0]).sort(), ['direction', 'occurredAt']);
    assert.ok(onlyIn.body[0].occurredAt < onlyIn.body[1].occurredAt);

    const page = await get(`/passages?deviceId=${device.device_id}&limit=1&page=2&sort=occurredAt`);
    assert.equal(page.body.length, 1);
    assert.equal(page.headers['x-total-count'], '3');

    // datas sem fuso na query string são interpretadas no fuso do servidor: aqui usamos o deslocamento local
    const offsetMs = new Date(base).getTimezoneOffset() * 60_000;
    const localIso = (ms: number) => new Date(ms - offsetMs).toISOString().slice(0, 19);
    const summary = await get(`/passages/summary?deviceId=${device.device_id}&window=1h&start_at=${localIso(base)}&end_at=${localIso(base + 2 * hour)}`);
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.window, '1h');
    assert.deepEqual(summary.body.windows.map((w: { in: number; out: number }) => [w.in, w.out]), [[1, 1], [1, 0]]);

    const foreign = await get(`/passages?deviceId=${device.device_id}`, otherClient.token);
    assert.equal(foreign.headers['x-total-count'], '0');
    const admin = await get(`/passages?deviceId=${device.device_id}`, adminToken);
    assert.equal(admin.headers['x-total-count'], '3');

    assert.equal((await get('/passages?eventId=x')).status, 400);
    assert.equal((await get('/passages/summary?window=1s')).status, 400);
    assert.equal((await get('/passages', manager.token)).status, 403);
  });

  test('listar e revogar dispositivos; o token revogado para de funcionar na hora', async () => {
    const device = await pair(client);
    const list = await request(ctx.app).get(`/devices?status=active&id=${device.device_id}`).auth(client.token, { type: 'bearer' });
    assert.equal(list.headers['x-total-count'], '1');
    assert.equal(list.body[0].name, 'Porta da sala');

    assert.equal((await request(ctx.app).delete(`/devices/${device.device_id}`).auth(otherClient.token, { type: 'bearer' })).status, 404);
    assert.equal((await request(ctx.app).delete(`/devices/${device.device_id}`).auth(client.token, { type: 'bearer' })).status, 204);
    const after = await send(device, { clientId: client.id, events: [event()] });
    assert.equal(after.status, 401);
  });
});
