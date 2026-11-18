import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { silentLogger } from '../../src/application/port/logger.ts';
import { connectMongo, migrateIndexes } from '../../src/infrastructure/database/mongo.database.ts';
import { RedisConnections } from '../../src/infrastructure/redis/redis.connections.ts';
import { envTls, mongoCredentials, redisCredentials } from '../helpers/connections.ts';
import { waitUntil } from '../helpers/wait.until.ts';

// Reconexão com credenciais/certificados novos (o que o SecretFileWatcher dispara) contra Mongo e Redis reais
describe('Reconfiguração sem reiniciar (requer REPOSITORY_DRIVER=mongo)', { skip: process.env.REPOSITORY_DRIVER !== 'mongo' }, () => {
  let db: Awaited<ReturnType<typeof connectMongo>>;
  const dbName = `${process.env.MONGO_DB ?? 'app'}_reload_test`;

  before(async () => {
    db = await connectMongo(process.env.MONGO_URI as string, dbName, {
      logger: silentLogger, tls: envTls.mongo, credentials: mongoCredentials(), autoIndex: false,
    });
  });
  after(async () => {
    await db.connection.dropDatabase();
    await db.close();
  });

  test('MongoDB: migração cria os índices que faltam e é idempotente', async () => {
    const first = await migrateIndexes(db.models as never);
    assert.ok(first.User.created.some(index => index.includes('email')), JSON.stringify(first.User));
    const second = await migrateIndexes(db.models as never);
    assert.deepEqual(second.User, { created: [], dropped: [] });
  });

  test('MongoDB: reconnect fecha e reabre a mesma conexão; os models continuam funcionando', async () => {
    await db.models.User.create({
      _id: crypto.randomUUID(), name: 'Antes', email: `a-${Date.now()}@x.com`, role: 'client', passwordHash: 'h',
      createdAt: new Date(), updatedAt: new Date(),
    });
    await db.reconnect({ uri: process.env.MONGO_URI as string, tls: envTls.mongo, credentials: mongoCredentials() });
    assert.equal(await db.models.User.countDocuments(), 1);
    await db.ping();
  });
});

describe('Redis: reconfigure refaz as conexões (requer QUEUE_DRIVER=redis)', { skip: process.env.QUEUE_DRIVER !== 'redis' }, () => {
  const redis = new RedisConnections(process.env.REDIS_URL as string, silentLogger, envTls.redis, redisCredentials());
  const queue = redis.forQueue('reload:queue');
  after(() => redis.close());

  test('depois do reconfigure, os comandos seguem funcionando na mesma instância do ioredis', async () => {
    await redis.ready();
    await queue.set('reload:test', 'antes');
    redis.reconfigure({ tls: envTls.redis, credentials: redisCredentials() });
    assert.equal(await queue.get('reload:test'), 'antes');
    await waitUntil(async () => redis.status()['reload:queue'], status => status === 'ready', 5000);
    await queue.del('reload:test');
  });
});
