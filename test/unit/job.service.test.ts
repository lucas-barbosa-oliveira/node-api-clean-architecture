import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobService } from '../../src/application/service/job.service.ts';
import { NotFoundError, ValidationError } from '../../src/domain/error/index.ts';
import { InMemoryJobRepository } from '../../src/infrastructure/repository/in-memory/in.memory.job.repository.ts';
import { InMemoryUserRepository } from '../../src/infrastructure/repository/in-memory/in.memory.user.repository.ts';
import { actorFor, actorOf, newUser } from '../helpers/fixtures.ts';

// regras de acesso: a fila não importa aqui
const noopQueue = { enqueue: async () => {}, close: async () => {} };

async function setup() {
  const users = new InMemoryUserRepository();
  const [managerA, managerB, clientA, clientB] = ['manager', 'manager', 'client', 'client'].map(role =>
    newUser(role as 'manager' | 'client'),
  );
  for (const user of [managerA, managerB, clientA, clientB]) await users.save(user);
  const service = new JobService(new InMemoryJobRepository(), noopQueue, users);
  const report = { type: 'report.generate', payload: { month: '2026-10' } };
  return { service, managerA, managerB, clientA, clientB, report };
}

test('o gestor do job vem do ator, e o cliente precisa existir com papel client', async () => {
  const { service, managerA, managerB, clientA, report } = await setup();
  const job = await service.submit(actorOf(managerA), { ...report, clientId: clientA.id });
  assert.equal(job.managerId, managerA.id);
  assert.equal(job.clientId, clientA.id);

  await assert.rejects(() => service.submit(actorOf(managerA), { ...report, clientId: crypto.randomUUID() }), ValidationError);
  await assert.rejects(() => service.submit(actorOf(managerA), { ...report, clientId: managerB.id }), ValidationError);
  await assert.rejects(() => service.submit(actorOf(managerA), { ...report, clientId: undefined }), ValidationError);
});

test('getById: gestor que criou, cliente associado e admin veem; os demais recebem 404', async () => {
  const { service, managerA, managerB, clientA, clientB, report } = await setup();
  const job = await service.submit(actorOf(managerA), { ...report, clientId: clientA.id });

  assert.equal((await service.getById(actorOf(managerA), job.id)).id, job.id);
  assert.equal((await service.getById(actorOf(clientA), job.id)).id, job.id);
  assert.equal((await service.getById(actorFor('admin'), job.id)).id, job.id);

  await assert.rejects(() => service.getById(actorOf(managerB), job.id), NotFoundError);
  await assert.rejects(() => service.getById(actorOf(clientB), job.id), NotFoundError);
});

test('list: cada um vê só os jobs em que participa; admin vê todos', async () => {
  const { service, managerA, managerB, clientA, clientB, report } = await setup();
  const a1 = await service.submit(actorOf(managerA), { ...report, clientId: clientA.id });
  const a2 = await service.submit(actorOf(managerA), { ...report, clientId: clientB.id });
  const b1 = await service.submit(actorOf(managerB), { ...report, clientId: clientA.id });

  const ids = async (actor: Parameters<JobService['list']>[0]) => (await service.list(actor)).map(job => job.id).sort();
  assert.deepEqual(await ids(actorOf(managerA)), [a1.id, a2.id].sort());
  assert.deepEqual(await ids(actorOf(managerB)), [b1.id]);
  assert.deepEqual(await ids(actorOf(clientA)), [a1.id, b1.id].sort());
  assert.deepEqual(await ids(actorOf(clientB)), [a2.id]);
  assert.deepEqual(await ids(actorFor('admin')), [a1.id, a2.id, b1.id].sort());
});
