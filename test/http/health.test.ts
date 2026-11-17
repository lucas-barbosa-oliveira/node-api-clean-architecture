import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { silentLogger } from '../../src/application/port/logger.ts';
import { isDependencyUnavailable } from '../../src/infrastructure/resilience/unavailable.ts';
import { errorHandler } from '../../src/presentation/http/error.handler.ts';
import { makeApp } from '../helpers/make.app.ts';

describe('Saúde e indisponibilidade', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  before(async () => { ctx = await makeApp(); });
  after(() => ctx.close());

  test('/health/live e /health/ready', async () => {
    const live = await request(ctx.app).get('/health/live').expect(200);
    assert.equal(live.body.status, 'ok');
    const ready = await request(ctx.app).get('/health/ready').expect(200);
    assert.equal(ready.body.status, 'ready');
    assert.ok(ready.body.checks.outbox);
    if (process.env.REPOSITORY_DRIVER === 'mongo') assert.equal(ready.body.checks.mongodb.status, 'up');
  });

  test('erro de dependência fora do ar vira 503 com Retry-After; bug continua 500', async () => {
    const app = express();
    app.get('/banco', () => { throw Object.assign(new Error('Server selection timed out'), { name: 'MongoServerSelectionError' }); });
    app.get('/bug', () => { throw new TypeError('x is undefined'); });
    app.use(errorHandler(silentLogger, { isUnavailable: isDependencyUnavailable }));

    const unavailable = await request(app).get('/banco').expect(503);
    assert.equal(unavailable.headers['retry-after'], '5');
    assert.equal(unavailable.body.code, 'UNAVAILABLE');
    await request(app).get('/bug').expect(500);
  });
});
