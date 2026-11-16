import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Job } from '../../src/domain/model/job.ts';
import { User } from '../../src/domain/model/user.ts';
import { jobSchema, userSchema } from '../../src/infrastructure/database/schema/index.ts';
import { JobMapper } from '../../src/infrastructure/mapper/job.mapper.ts';
import { UserMapper } from '../../src/infrastructure/mapper/user.mapper.ts';

// sem conexão: não tentar criar índices/coleções
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

test('documentos gerados pelos mappers são válidos nos schemas', async () => {
  const UserModel = mongoose.model('SchemaTestUser', userSchema);
  const JobModel = mongoose.model('SchemaTestJob', jobSchema);

  const userDoc = new UserMapper().transform(User.create({ name: 'Ana', email: 'ana@x.com' }));
  const jobDoc = new JobMapper().transform(Job.create('report.generate', { month: '2026-10' }));

  await new UserModel(userDoc).validate();
  await new JobModel(jobDoc).validate();
});

test('o schema rejeita documento sem campos obrigatórios e status inválido', async () => {
  const UserModel = mongoose.model('SchemaTestUser2', userSchema);
  const JobModel = mongoose.model('SchemaTestJob2', jobSchema);

  await assert.rejects(() => new UserModel({ _id: 'x', name: 'Ana' }).validate());

  const jobDoc = new JobMapper().transform(Job.create('x', {}));
  await assert.rejects(() => new JobModel({ ...jobDoc, status: 'desconhecido' }).validate());
});

test('minimize: false preserva payload/result vazios ({})', () => {
  const JobModel = mongoose.model('SchemaTestJob3', jobSchema);
  const jobDoc = new JobMapper().transform(Job.create('x', {}));
  const stored = new JobModel(jobDoc).toObject();
  assert.deepEqual(stored.payload, {});
});
