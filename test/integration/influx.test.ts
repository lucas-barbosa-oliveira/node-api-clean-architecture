import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { InfluxPassageStore } from '../../src/infrastructure/timeseries/influx.passage.store.ts';
import type { Passage } from '../../src/domain/model/passage.ts';
import { listQuery } from '../helpers/fixtures.ts';
import { envTls, influxToken } from '../helpers/connections.ts';

const config = {
  url: process.env.INFLUX_URL as string,
  token: influxToken(),
  org: process.env.INFLUX_ORG as string,
  bucket: process.env.INFLUX_BUCKET as string,
  tls: envTls.influx,
};

// Só roda com um InfluxDB disponível (npm run docker:up && npm run test:docker).
describe('InfluxDB (requer TIMESERIES_DRIVER=influx)', { skip: process.env.TIMESERIES_DRIVER !== 'influx' }, () => {
  const store = new InfluxPassageStore(config);
  after(() => store.close());

  const hour = 3_600_000;
  const base = Math.floor(Date.now() / hour) * hour - 3 * hour;
  const passage = (deviceId: string, clientId: string, offsetMs: number, direction: Passage['direction'] = 'in'): Passage => ({
    eventId: crypto.randomUUID(),
    occurredAt: new Date(base + offsetMs),
    direction,
    sequence: offsetMs,
    deviceId,
    clientId,
    receivedAt: new Date(),
  });

  test('grava, consulta com filtro/ordenação/paginação e conta o total', async () => {
    const [deviceId, clientId] = [crypto.randomUUID(), crypto.randomUUID()];
    await store.write(
      [passage(deviceId, clientId, 1000), passage(deviceId, clientId, 2000, 'out'), passage(deviceId, clientId, 3000)],
      { deviceId, clientId, receivedAt: new Date(), rssi: -50, firmware: '1.0.0', uptimeSeconds: 5 },
    );
    const all = await store.list(listQuery({ filter: { deviceId }, sort: { occurredAt: 1 } }));
    assert.equal(all.total, 3);
    assert.deepEqual(all.items.map(p => p.sequence), [1000, 2000, 3000]);
    assert.ok(all.items.every(p => p.clientId === clientId && p.receivedAt instanceof Date && p.eventId));

    const page = await store.list(listQuery({ filter: { deviceId, direction: 'in' }, sort: { occurredAt: -1 }, limit: 1, skip: 1 }));
    assert.equal(page.total, 2);
    assert.deepEqual(page.items.map(p => p.sequence), [1000]);
  });

  test('reenviar o mesmo evento sobrescreve o ponto (idempotente)', async () => {
    const [deviceId, clientId] = [crypto.randomUUID(), crypto.randomUUID()];
    const once = passage(deviceId, clientId, 5000);
    await store.write([once]);
    await store.write([once]);
    assert.equal((await store.list(listQuery({ filter: { deviceId } }))).total, 1);
  });

  test('resumo por janela soma entradas e saídas, com zero nas janelas vazias', async () => {
    const [deviceId, clientId] = [crypto.randomUUID(), crypto.randomUUID()];
    await store.write([
      passage(deviceId, clientId, 60_000),
      passage(deviceId, clientId, 120_000),
      passage(deviceId, clientId, 2 * hour + 1000, 'out'),
    ]);
    const windows = await store.summarize(
      { deviceId, occurredAt: { $gte: new Date(base), $lt: new Date(base + 3 * hour) } },
      { every: '1h', ms: hour },
    );
    assert.deepEqual(windows.map(w => [w.start.getTime() - base, w.in, w.out, w.unknown]), [[0, 2, 0, 0], [hour, 0, 0, 0], [2 * hour, 0, 1, 0]]);
  });

  test('strings maliciosas no filtro não alteram a consulta', async () => {
    const page = await store.list(listQuery({ filter: { deviceId: 'x") or true or ("' } }));
    assert.equal(page.total, 0);
  });
});
