import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp } from '../helpers/make.app.ts';
import { waitForJob } from '../helpers/wait.for.job.ts';

describe('Reports API (job assíncrono)', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  before(async () => { ctx = await makeApp(); });
  after(() => ctx.close());

  test('POST /reports responde 202 e o job conclui', async () => {
    const res = await request(ctx.app).post('/reports').send({ month: '2026-10' });
    assert.equal(res.status, 202);
    assert.equal(res.headers.location, `/jobs/${res.body.id}`);
    assert.equal(res.body.status, 'pending');

    const job = await waitForJob(ctx.app, res.body.id);
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(job.result, { month: '2026-10', rows: 42 });
  });

  test('POST /reports valida o corpo com 400', async () => {
    const res = await request(ctx.app).post('/reports').send({ month: 'outubro' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION');
  });

  test('GET /jobs/:id retorna 404 se não existir', async () => {
    const res = await request(ctx.app).get(`/jobs/${crypto.randomUUID()}`);
    assert.equal(res.status, 404);
  });

  test('vários jobs em paralelo terminam todos', async () => {
    const ids = await Promise.all(
      ['2026-01', '2026-02', '2026-03'].map(async month => (await request(ctx.app).post('/reports').send({ month })).body.id),
    );
    const jobs = await Promise.all(ids.map(id => waitForJob(ctx.app, id)));
    assert.deepEqual(jobs.map(job => job.status), ['succeeded', 'succeeded', 'succeeded']);
  });
});

describe('Duas instâncias da aplicação (requer QUEUE_DRIVER=redis + Mongo)', { skip: process.env.QUEUE_DRIVER !== 'redis' }, () => {
  test('job enviado por uma instância conclui e é visível pela outra', async () => {
    const a = await makeApp();
    const b = await makeApp();
    try {
      const res = await request(a.app).post('/reports').send({ month: '2026-10' });
      assert.equal(res.status, 202);
      const job = await waitForJob(b.app, res.body.id);
      assert.equal(job.status, 'succeeded');
    } finally {
      await a.close();
      await b.close();
    }
  });
});
