import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Entity } from '../../src/domain/model/entity.ts';
import { Job } from '../../src/domain/model/job.ts';
import { newUser } from '../helpers/fixtures.ts';

test('todo model herda id, createdAt e updatedAt de Entity', () => {
  const user = newUser('client');
  assert.ok(user instanceof Entity);
  assert.match(user.id, /^[0-9a-f-]{36}$/);
  assert.equal(user.createdAt.getTime(), user.updatedAt.getTime());
});

test('transições do Job atualizam status, datas e updatedAt', async () => {
  const job = Job.create({ type: 'report.generate', payload: { month: '2026-10' }, managerId: 'gestor-1', clientId: 'cliente-1' });
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

  const failed = Job.create({ type: 'x', payload: {}, managerId: 'gestor-1', clientId: 'cliente-1' });
  failed.fail('boom');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom');
});

test('Job.involves: só o gestor que criou e o cliente associado participam', () => {
  const job = Job.create({ type: 'x', payload: {}, managerId: 'gestor-1', clientId: 'cliente-1' });
  assert.equal(job.involves('gestor-1'), true);
  assert.equal(job.involves('cliente-1'), true);
  assert.equal(job.involves('outro'), false);
});

test('User.toJSON nunca expõe o hash da senha', () => {
  const json = JSON.parse(JSON.stringify(newUser('manager')));
  assert.equal(json.passwordHash, undefined);
  assert.equal(json.role, 'manager');
});
