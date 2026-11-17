import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { silentLogger } from '../../src/application/port/logger.ts';
import { connectMongo } from '../../src/infrastructure/database/mongo.database.ts';
import { MongoUnitOfWork } from '../../src/infrastructure/database/mongo.unit.of.work.ts';
import { MongoOutbox } from '../../src/infrastructure/outbox/mongo.outbox.ts';
import { MongoUserRepository } from '../../src/infrastructure/repository/mongo/mongo.user.repository.ts';
import { newUser } from '../helpers/fixtures.ts';

// Só roda com o MongoDB do compose (replica set): npm run docker:infra && npm run test:docker
describe('Outbox transacional no MongoDB (requer REPOSITORY_DRIVER=mongo)', { skip: process.env.REPOSITORY_DRIVER !== 'mongo' }, () => {
  let db: Awaited<ReturnType<typeof connectMongo>>;
  let users: MongoUserRepository;
  let outbox: MongoOutbox;
  let uow: MongoUnitOfWork;
  const event = (id: string) => ({ exchange: 'users', routingKey: 'users.created', event: { event_name: 'UserCreatedEvent', timestamp: '', user: { id } } });
  const outboxHas = async (id: string) => (await db.models.OutboxEvent.find({ payload: { $regex: id } }).lean()).length;

  before(async () => {
    db = await connectMongo(process.env.MONGO_URI as string, `${process.env.MONGO_DB ?? 'app'}_outbox_test`, { logger: silentLogger });
    assert.ok(db.supportsTransactions, 'o MongoDB do compose precisa estar como replica set');
    users = new MongoUserRepository(db.models.User);
    outbox = new MongoOutbox(db.models.OutboxEvent);
    uow = new MongoUnitOfWork(db.connection);
  });
  after(async () => {
    await db.connection.dropDatabase();
    await db.close();
  });

  test('dado e evento são gravados juntos', async () => {
    const user = newUser('client');
    await uow.run(async () => {
      await users.save(user);
      await outbox.add(event(user.id));
    });
    assert.ok(await users.findById(user.id));
    assert.equal(await outboxHas(user.id), 1);
  });

  test('erro depois de gravar: nem o dado nem o evento ficam', async () => {
    const user = newUser('client');
    await assert.rejects(uow.run(async () => {
      await users.save(user);
      await outbox.add(event(user.id));
      throw new Error('falha no meio');
    }), /falha no meio/);
    assert.equal(await users.findById(user.id), null);
    assert.equal(await outboxHas(user.id), 0);
  });

  test('reserva atômica: duas instâncias não pegam o mesmo evento', async () => {
    for (let i = 0; i < 20; i++) await outbox.add(event(`claim-${i}`));
    const [a, b] = await Promise.all([outbox.claim(15, 30_000), outbox.claim(15, 30_000)]);
    const ids = [...a, ...b].map(r => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const record of [...a, ...b]) await outbox.markSent(record.id);
  });
});
