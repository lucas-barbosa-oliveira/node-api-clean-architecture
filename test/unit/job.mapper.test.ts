import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Job } from '../../src/domain/model/job.ts';
import { User } from '../../src/domain/model/user.ts';
import { JobMapper } from '../../src/infrastructure/mapper/job.mapper.ts';
import { UserMapper } from '../../src/infrastructure/mapper/user.mapper.ts';

test('transform converte model → documento → model', () => {
  const mapper = new JobMapper();
  const job = Job.create('report.generate', { month: '2026-10' });

  const doc = mapper.transform(job);
  assert.equal(doc._id, job.id);

  const back = mapper.transform(doc);
  assert.ok(back instanceof Job);
  assert.deepEqual(back, job);
});

test('transform aceita documento que passou por JSON (datas viram string)', () => {
  const mapper = new JobMapper();
  const job = Job.create('report.generate', { month: '2026-10' });
  job.start();
  job.succeed({ rows: 3 });

  const fromJson = mapper.transform(JSON.parse(JSON.stringify(mapper.transform(job))));
  assert.ok(fromJson instanceof Job);
  assert.equal(fromJson.createdAt.getTime(), job.createdAt.getTime());
  assert.equal(fromJson.finishedAt?.getTime(), job.finishedAt?.getTime());
  assert.deepEqual(fromJson.result, { rows: 3 });
});

test('transform trata null e listas', () => {
  const mapper = new UserMapper();
  assert.equal(mapper.transform(null), null);
  assert.equal(mapper.transform(undefined), null);

  const users = [User.create({ name: 'Ana', email: 'a@x.com' }), User.create({ name: 'Bia', email: 'b@x.com' })];
  const docs = mapper.transform(users);
  assert.equal(docs.length, 2);
  assert.deepEqual(mapper.transform(docs), users);
});
