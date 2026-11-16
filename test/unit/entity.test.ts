import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Entity } from '../../src/domain/model/entity.ts';
import { Job } from '../../src/domain/model/job.ts';
import { User } from '../../src/domain/model/user.ts';

test('todo model herda id, createdAt e updatedAt de Entity', () => {
  const user = User.create({ name: 'Ana', email: 'ana@x.com' });
  assert.ok(user instanceof Entity);
  assert.match(user.id, /^[0-9a-f-]{36}$/);
  assert.equal(user.createdAt.getTime(), user.updatedAt.getTime());
});

test('transições do Job atualizam status, datas e updatedAt', async () => {
  const job = Job.create('report.generate', { month: '2026-10' });
  assert.equal(job.status, 'pending');

  await sleep(5);
  job.start();
  assert.equal(job.status, 'running');
  assert.ok(job.startedAt);
  assert.ok(job.updatedAt.getTime() > job.createdAt.getTime());

  job.succeed({ rows: 1 });
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.result, { rows: 1 });
  assert.ok(job.finishedAt);

  const failed = Job.create('x', {});
  failed.fail('boom');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom');
});
