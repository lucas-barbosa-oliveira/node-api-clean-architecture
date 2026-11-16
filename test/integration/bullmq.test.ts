import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { JobHandler } from '../../src/application/port/job.handler.ts';
import { JobService } from '../../src/application/service/job.service.ts';
import { BullMqScheduler } from '../../src/background/scheduler/bullmq.scheduler.ts';
import { BullMqJobQueue } from '../../src/infrastructure/queue/bullmq.job.queue.ts';
import { RedisConnections } from '../../src/infrastructure/redis/redis.connections.ts';
import { InMemoryJobRepository } from '../../src/infrastructure/repository/in-memory/in.memory.job.repository.ts';
import { waitUntil } from '../helpers/wait.until.ts';

const redisUrl = process.env.REDIS_URL;

// Estes testes só rodam com um Redis disponível (npm run docker:up && npm run test:docker).
describe('BullMQ (requer Redis)', { skip: !redisUrl }, () => {
  const connections = new RedisConnections(redisUrl as string);
  const janitor = connections.forQueue();
  const queueNames: string[] = [];
  const newQueueName = (prefix: string) => {
    const name = `test-${prefix}-${crypto.randomUUID()}`;
    queueNames.push(name);
    return name;
  };

  after(async () => {
    for (const name of queueNames) {
      const keys = await janitor.keys(`bull:${name}:*`);
      if (keys.length > 0) await janitor.del(...keys);
    }
    await connections.close();
  });

  function newQueue(repo: InMemoryJobRepository, handlers: Record<string, JobHandler>, queueName: string) {
    return new BullMqJobQueue({
      repo,
      handlers,
      queueName,
      queueConnection: connections.forQueue(),
      workerConnection: connections.forWorker(),
    });
  }

  test('job processado pelo worker: pending → succeeded', async () => {
    const repo = new InMemoryJobRepository();
    const queue = newQueue(repo, { 'report.generate': async () => ({ rows: 5 }) }, newQueueName('ok'));
    const service = new JobService(repo, queue);
    try {
      const job = await service.submit('report.generate', { month: '2026-10' });
      const done = await waitUntil(() => service.getById(job.id), j => j.status === 'succeeded' || j.status === 'failed');
      assert.equal(done.status, 'succeeded');
      assert.deepEqual(done.result, { rows: 5 });
    } finally {
      await queue.close();
    }
  });

  test('erro de negócio no handler vira failed, sem retentativas', async () => {
    const repo = new InMemoryJobRepository();
    let calls = 0;
    const queue = newQueue(
      repo,
      { 'report.generate': async () => { calls++; throw new Error('boom'); } },
      newQueueName('fail'),
    );
    const service = new JobService(repo, queue);
    try {
      const job = await service.submit('report.generate', { month: '2026-10' });
      const done = await waitUntil(() => service.getById(job.id), j => j.status === 'succeeded' || j.status === 'failed');
      assert.equal(done.status, 'failed');
      assert.equal(done.error, 'boom');
      await sleep(200);
      assert.equal(calls, 1);
    } finally {
      await queue.close();
    }
  });

  test('enfileirar o mesmo job duas vezes executa o handler uma vez', async () => {
    const repo = new InMemoryJobRepository();
    let calls = 0;
    const queue = newQueue(repo, { 'report.generate': async () => { calls++; return null; } }, newQueueName('dedupe'));
    const service = new JobService(repo, queue);
    try {
      const job = await service.submit('report.generate', { month: '2026-10' });
      await queue.enqueue(job.id);
      await queue.enqueue(job.id);
      await waitUntil(() => service.getById(job.id), j => j.status === 'succeeded');
      await sleep(300);
      assert.equal(calls, 1);
    } finally {
      await queue.close();
    }
  });

  test('duas "instâncias" compartilhando a fila: cada job executa exatamente uma vez', async () => {
    const repo = new InMemoryJobRepository(); // em produção seria um repositório compartilhado (Mongo)
    const name = newQueueName('multi');
    const runs = new Map<string, number>();
    const handlers: Record<string, JobHandler> = {
      'report.generate': async job => {
        runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
        await sleep(20);
        return null;
      },
    };
    const instanceA = newQueue(repo, handlers, name);
    const instanceB = newQueue(repo, handlers, name);
    const serviceA = new JobService(repo, instanceA);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push((await serviceA.submit('report.generate', { month: '2026-10' })).id);
      for (const id of ids) {
        await waitUntil(() => serviceA.getById(id), j => j.status === 'succeeded');
      }
      assert.equal(runs.size, 8);
      assert.ok([...runs.values()].every(count => count === 1));
    } finally {
      await instanceA.close();
      await instanceB.close();
    }
  });

  test('scheduler: task de startup roda uma única vez mesmo com duas instâncias', async () => {
    const name = newQueueName('startup');
    let runs = 0;
    const tasks = [{ name: 'startup-task', runOnStartup: true, run: async () => { runs++; } }];
    const make = () =>
      new BullMqScheduler({ tasks, queueName: name, queueConnection: connections.forQueue(), workerConnection: connections.forWorker() });
    const a = make();
    const b = make();
    try {
      await Promise.all([a.start(), b.start()]);
      await waitUntil(async () => runs, value => value >= 1);
      await sleep(500);
      assert.equal(runs, 1);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  test('scheduler: task agendada dispara conforme o cron', async () => {
    const name = newQueueName('cron');
    let runs = 0;
    const scheduler = new BullMqScheduler({
      tasks: [{ name: 'tick', schedule: '* * * * * *', run: async () => { runs++; } }], // a cada segundo
      queueName: name,
      queueConnection: connections.forQueue(),
      workerConnection: connections.forWorker(),
    });
    try {
      await scheduler.start();
      await waitUntil(async () => runs, value => value >= 2, 6000);
    } finally {
      await scheduler.stop();
    }
  });

  test('scheduler: stop() sem start() não trava', async () => {
    const scheduler = new BullMqScheduler({
      tasks: [],
      queueName: newQueueName('stop'),
      queueConnection: connections.forQueue(),
      workerConnection: connections.forWorker(),
    });
    await Promise.race([
      scheduler.stop(),
      sleep(5000).then(() => { throw new Error('stop() travou'); }),
    ]);
  });
});
