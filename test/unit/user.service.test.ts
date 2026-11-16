import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserService } from '../../src/application/service/user.service.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/error/index.ts';
import { InMemoryUserRepository } from '../../src/infrastructure/repository/in-memory/in.memory.user.repository.ts';

test('normaliza nome e e-mail e impede e-mail duplicado', async () => {
  const service = new UserService(new InMemoryUserRepository());
  const user = await service.create({ name: ' Ana ', email: '  ANA@X.com ' });
  assert.equal(user.name, 'Ana');
  assert.equal(user.email, 'ana@x.com');
  await assert.rejects(() => service.create({ name: 'Ana', email: 'ana@x.com' }), ConflictError);
});

test('valida os dados de entrada', async () => {
  const service = new UserService(new InMemoryUserRepository());
  await assert.rejects(() => service.create({ name: 'A', email: 'x' }), ValidationError);
  await assert.rejects(() => service.create(undefined), ValidationError);
});

test('getById devolve o usuário ou NotFoundError', async () => {
  const service = new UserService(new InMemoryUserRepository());
  const created = await service.create({ name: 'Bia', email: 'bia@x.com' });
  assert.equal((await service.getById(created.id)).email, 'bia@x.com');
  await assert.rejects(() => service.getById('inexistente'), NotFoundError);
});
