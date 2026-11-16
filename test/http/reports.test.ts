import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createUser, loginAsAdmin, makeApp, type TestUser } from '../helpers/make.app.ts';
import { waitForJob } from '../helpers/wait.for.job.ts';

describe('Reports/Jobs API (job assíncrono com controle de acesso)', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let adminToken: string;
  let managerA: TestUser;
  let managerB: TestUser;
  let clientA: TestUser;
  let clientB: TestUser;

  before(async () => {
    ctx = await makeApp();
    adminToken = await loginAsAdmin(ctx.app);
    [managerA, managerB, clientA, clientB] = await Promise.all([
      createUser(ctx.app, adminToken, 'manager'),
      createUser(ctx.app, adminToken, 'manager'),
      createUser(ctx.app, adminToken, 'client'),
      createUser(ctx.app, adminToken, 'client'),
    ]);
  });
  after(() => ctx.close());

  const submit = (token: string, body: object) => request(ctx.app).post('/reports').auth(token, { type: 'bearer' }).send(body);
  const getJob = (token: string, id: string) => request(ctx.app).get(`/jobs/${id}`).auth(token, { type: 'bearer' });

  test('gestor cria um job para um cliente: 202, o gestor vem do token e o job conclui', async () => {
    const res = await submit(managerA.token, { clientId: clientA.id, month: '2026-10', managerId: 'tentativa-de-forjar' });
    assert.equal(res.status, 202);
    assert.equal(res.headers.location, `/jobs/${res.body.id}`);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.managerId, managerA.id);
    assert.equal(res.body.clientId, clientA.id);
    assert.deepEqual(res.body.payload, { month: '2026-10' });

    const job = await waitForJob(ctx.app, managerA.token, res.body.id);
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(job.result, { month: '2026-10', rows: 42 });
  });

  test('somente gestores criam jobs: cliente e admin recebem 403', async () => {
    assert.equal((await submit(clientA.token, { clientId: clientA.id, month: '2026-10' })).status, 403);
    assert.equal((await submit(adminToken, { clientId: clientA.id, month: '2026-10' })).status, 403);
  });

  test('o job precisa ser associado a um cliente existente (400)', async () => {
    for (const clientId of [undefined, crypto.randomUUID(), managerB.id]) {
      const res = await submit(managerA.token, { clientId, month: '2026-10' });
      assert.equal(res.status, 400, `clientId=${clientId}`);
      assert.equal(res.body.code, 'VALIDATION');
    }
  });

  test('POST /reports valida o payload com 400', async () => {
    const res = await submit(managerA.token, { clientId: clientA.id, month: 'outubro' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION');
  });

  test('GET /jobs/:id: gestor criador, cliente associado e admin veem; os demais recebem 404', async () => {
    const { body: job } = await submit(managerA.token, { clientId: clientA.id, month: '2026-11' });

    for (const token of [managerA.token, clientA.token, adminToken]) {
      assert.equal((await getJob(token, job.id)).status, 200);
    }
    for (const token of [managerB.token, clientB.token]) {
      const res = await getJob(token, job.id);
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'NOT_FOUND');
    }
  });

  test('GET /jobs/:id retorna 404 se não existir', async () => {
    assert.equal((await getJob(adminToken, crypto.randomUUID())).status, 404);
  });

  test('GET /jobs lista apenas os jobs de cada um; admin vê todos', async () => {
    const { body: forB } = await submit(managerA.token, { clientId: clientB.id, month: '2026-12' });
    const { body: fromB } = await submit(managerB.token, { clientId: clientB.id, month: '2026-12' });
    const list = async (token: string) =>
      ((await request(ctx.app).get('/jobs').auth(token, { type: 'bearer' })).body as { id: string }[]).map(job => job.id);

    const ofClientB = await list(clientB.token);
    assert.ok(ofClientB.includes(forB.id) && ofClientB.includes(fromB.id));
    assert.ok(!(await list(clientA.token)).some(id => id === forB.id || id === fromB.id));

    const ofManagerB = await list(managerB.token);
    assert.deepEqual(ofManagerB, [fromB.id]);

    const ofAdmin = await list(adminToken);
    assert.ok(ofAdmin.includes(forB.id) && ofAdmin.includes(fromB.id));
  });

  test('vários jobs em paralelo terminam todos', async () => {
    const ids = await Promise.all(
      ['2026-01', '2026-02', '2026-03'].map(async month => (await submit(managerA.token, { clientId: clientA.id, month })).body.id),
    );
    const jobs = await Promise.all(ids.map(id => waitForJob(ctx.app, clientA.token, id)));
    assert.deepEqual(jobs.map(job => job.status), ['succeeded', 'succeeded', 'succeeded']);
  });
});

describe('Duas instâncias da aplicação (requer QUEUE_DRIVER=redis + Mongo)', { skip: process.env.QUEUE_DRIVER !== 'redis' }, () => {
  test('job enviado por uma instância conclui e é visível pela outra', async () => {
    // as duas instâncias precisam validar os mesmos tokens: exige JWT_PRIVATE_KEY_PATH/JWT_PUBLIC_KEY_PATH
    const a = await makeApp();
    const b = await makeApp();
    try {
      const adminToken = await loginAsAdmin(a.app);
      const manager = await createUser(a.app, adminToken, 'manager');
      const client = await createUser(a.app, adminToken, 'client');
      const res = await request(a.app).post('/reports').auth(manager.token, { type: 'bearer' }).send({ clientId: client.id, month: '2026-10' });
      assert.equal(res.status, 202);
      const job = await waitForJob(b.app, client.token, res.body.id);
      assert.equal(job.status, 'succeeded');
    } finally {
      await a.close();
      await b.close();
    }
  });
});
