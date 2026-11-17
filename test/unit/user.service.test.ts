import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserService } from '../../src/application/service/user.service.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/error/index.ts';
import { ScryptPasswordHasher } from '../../src/infrastructure/security/scrypt.password.hasher.ts';
import { InMemoryUserRepository } from '../../src/infrastructure/repository/in-memory/in.memory.user.repository.ts';
import { actorFor, actorOf, listQuery } from '../helpers/fixtures.ts';
import { InMemoryOutbox } from '../../src/infrastructure/outbox/in.memory.outbox.ts';
import { noTransaction } from '../../src/application/port/unit.of.work.ts';

const setup = () => {
  const repo = new InMemoryUserRepository();
  const hasher = new ScryptPasswordHasher();
  return { repo, hasher, service: new UserService(repo, hasher, { outbox: new InMemoryOutbox(), unitOfWork: noTransaction }) };
};
const valid = { name: ' Ana ', email: '  ANA@X.com ', password: 'senha-forte', role: 'manager' };

test('normaliza nome e e-mail, guarda só o hash da senha e impede e-mail duplicado', async () => {
  const { service, hasher } = setup();
  const user = await service.create(valid);
  assert.equal(user.name, 'Ana');
  assert.equal(user.email, 'ana@x.com');
  assert.equal(user.role, 'manager');
  assert.notEqual(user.passwordHash, valid.password);
  assert.equal(await hasher.verify(valid.password, user.passwordHash), true);
  await assert.rejects(() => service.create({ ...valid, email: 'ana@x.com' }), ConflictError);
});

test('valida os dados de entrada e não permite cadastrar administrador pela API', async () => {
  const { service } = setup();
  await assert.rejects(() => service.create({ ...valid, name: 'A' }), ValidationError);
  await assert.rejects(() => service.create({ ...valid, password: 'curta' }), ValidationError);
  await assert.rejects(() => service.create({ ...valid, role: 'admin' }), ValidationError);
  await assert.rejects(() => service.create(undefined), ValidationError);
});

test('getById: o próprio usuário e o admin veem; outro usuário recebe NotFound', async () => {
  const { service } = setup();
  const ana = await service.create({ ...valid, email: 'ana@x.com' });
  const bia = await service.create({ ...valid, email: 'bia@x.com', role: 'client' });

  assert.equal((await service.getById(actorOf(ana), ana.id)).email, 'ana@x.com');
  assert.equal((await service.getById(actorFor('admin'), bia.id)).email, 'bia@x.com');
  await assert.rejects(() => service.getById(actorOf(ana), bia.id), NotFoundError);
  await assert.rejects(() => service.getById(actorFor('admin'), 'inexistente'), NotFoundError);
});

test('listClients devolve apenas clientes', async () => {
  const { service } = setup();
  await service.create({ ...valid, email: 'gestor@x.com' });
  const client = await service.create({ ...valid, email: 'cliente@x.com', role: 'client' });
  assert.deepEqual((await service.listClients(listQuery())).items.map(user => user.id), [client.id]);
  // ?role=manager na query string não escapa do filtro de clientes
  assert.equal((await service.listClients(listQuery({ filter: { role: 'manager' } }))).total, 0);
});

test('ensureAdmin cria o administrador uma única vez', async () => {
  const { service, repo } = setup();
  await service.ensureAdmin({ name: 'Admin', email: 'ADMIN@x.com', password: 'senha-admin' });
  await service.ensureAdmin({ name: 'Admin', email: 'admin@x.com', password: 'senha-admin' });
  assert.equal((await repo.list(listQuery({ filter: { role: 'admin' } }))).total, 1);
  assert.equal((await repo.findByEmail('admin@x.com'))?.role, 'admin');
});
