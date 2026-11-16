import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { JobHandler } from '../../src/application/port/job.handler.ts';
import { JobService } from '../../src/application/service/job.service.ts';
import { ValidationError } from '../../src/domain/error/index.ts';
import { Job } from '../../src/domain/model/job.ts';
import { InProcessJobQueue } from '../../src/infrastructure/queue/in.process.job.queue.ts';
import { InMemoryJobRepository } from '../../src/infrastructure/repository/in-memory/in.memory.job.repository.ts';
import { InMemoryUserRepository } from '../../src/infrastructure/repository/in-memory/in.memory.user.repository.ts';
import { actorFor, actorOf, newUser } from '../helpers/fixtures.ts';

async function setup(handlers: Record<string, JobHandler>, concurrency = 2) {
  const repo = new InMemoryJobRepository();
  const users = new InMemoryUserRepository();
  const client = newUser('client');
  await users.save(client);
  const queue = new InProcessJobQueue(repo, handlers, concurrency);
  const service = new JobService(repo, queue, users);
  const manager = actorOf(newUser('manager'));
  const admin = actorFor('admin');
  const submit = (payload: unknown, type = 'report.generate') => service.submit(manager, { type, clientId: client.id, payload });
  const owned = (props: Partial<ConstructorParameters<typeof Job>[0]> = {}) =>
    new Job({ type: 'report.generate', payload: { month: '2026-10' }, managerId: manager.userId, clientId: client.id, ...props });
  return { repo, queue, service, admin, submit, owned };
}

test('job concluído: pending → succeeded com resultado', async () => {
  const { queue, service, admin, submit } = await setup({ 'report.generate': async () => ({ rows: 7 }) });
  const job = await submit({ month: '2026-10' });
  assert.equal(job.status, 'pending');

  await queue.drain();
  const done = await service.getById(admin, job.id);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.result, { rows: 7 });
  assert.ok(done.startedAt && done.finishedAt);
});

test('handler que falha deixa o job como failed com a mensagem', async () => {
  const { queue, service, admin, submit } = await setup({
    'report.generate': async () => {
      throw new Error('boom');
    },
  });
  const job = await submit({ month: '2026-10' });
  await queue.drain();
  const done = await service.getById(admin, job.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'boom');
});

test('rejeita tipo desconhecido e payload inválido sem criar job', async () => {
  const { service, admin, submit } = await setup({});
  await assert.rejects(() => submit({}, 'nao.existe'), ValidationError);
  await assert.rejects(() => submit({ month: 'outubro' }), ValidationError);
  assert.deepEqual(await service.list(admin), []);
});

test('respeita o limite de concorrência', async () => {
  let current = 0;
  let max = 0;
  const { queue, submit } = await setup(
    {
      'report.generate': async () => {
        current++;
        max = Math.max(max, current);
        await sleep(20);
        current--;
        return null;
      },
    },
    2,
  );
  for (let i = 0; i < 6; i++) await submit({ month: '2026-10' });
  await queue.drain();
  assert.equal(max, 2);
});

test('recoverStale: running vira failed e pending volta para a fila', async () => {
  const { repo, queue, service, admin, owned } = await setup({ 'report.generate': async () => ({ ok: true }) });
  const interrupted = owned({ status: 'running' });
  const waiting = owned();
  await repo.save(interrupted);
  await repo.save(waiting);

  await service.recoverStale();
  await queue.drain();

  assert.equal((await service.getById(admin, interrupted.id)).status, 'failed');
  assert.equal((await service.getById(admin, waiting.id)).status, 'succeeded');
});

test('close() espera os jobs em andamento terminarem', async () => {
  const { queue, service, admin, submit } = await setup({
    'report.generate': async () => {
      await sleep(50);
      return 'ok';
    },
  });
  const job = await submit({ month: '2026-10' });
  await sleep(10); // deixa o job começar
  await queue.close();
  assert.equal((await service.getById(admin, job.id)).status, 'succeeded');
});

test('purgeOlderThan remove jobs finalizados antigos', async () => {
  const { repo, service, owned } = await setup({});
  const old = owned({ status: 'succeeded', finishedAt: new Date(Date.now() - 10 * 86_400_000) });
  const recent = owned({ status: 'succeeded', finishedAt: new Date() });
  await repo.save(old);
  await repo.save(recent);

  assert.equal(await service.purgeOlderThan(7), 1);
  assert.equal(await repo.findById(old.id), null);
  assert.ok(await repo.findById(recent.id));
});
