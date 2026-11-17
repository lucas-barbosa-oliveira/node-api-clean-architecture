import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { amqpClient, type IConnection } from 'amqp-client-node';
import { EventBusUnavailableError, type IntegrationEvent } from '../../src/application/port/event.bus.ts';
import { RabbitMqEventBus } from '../../src/infrastructure/eventbus/rabbitmq.event.bus.ts';
import { waitUntil } from '../helpers/wait.until.ts';

// Só roda com um RabbitMQ disponível (npm run docker:infra && npm run test:docker).
// Dois "microsserviços" no mesmo processo, mais um terceiro usando a amqp-client-node (como os serviços antigos).
describe('RabbitMQ (requer EVENT_BUS_DRIVER=rabbitmq)', { skip: process.env.EVENT_BUS_DRIVER !== 'rabbitmq' }, () => {
  const uri = process.env.RABBITMQ_URI as string;
  const producer = new RabbitMqEventBus({ uri, service: 'it-producer' });
  const consumer = new RabbitMqEventBus({ uri, service: 'it-consumer' });
  const received: IntegrationEvent[] = [];
  let legacy: IConnection;

  const event = (id: string): IntegrationEvent => ({ event_name: 'ItemCreatedEvent', timestamp: new Date().toISOString(), item: { id } });
  const ids = () => received.map(e => (e.item as { id: string }).id);
  const legacyOptions = { exchange: { type: 'topic', durable: true } };

  before(async () => {
    consumer.subscribe({ eventName: 'ItemCreatedEvent', exchange: 'it-events', routingKey: 'items.*', handle: async e => { received.push(e); } });
    consumer.provideResource({ name: 'items.sum', handle: async (a, b) => Number(a) + Number(b) });
    consumer.provideResource({ name: 'items.fail', handle: async () => { throw new Error('item inexistente'); } });

    await assert.rejects(producer.publish('it-events', 'items.created', event('x')), EventBusUnavailableError);
    producer.start();
    consumer.start();
    await waitUntil(async () => producer.isConnected && Object.values(consumer.status()).every(Boolean), Boolean, 15_000);
    legacy = await amqpClient.createConnection(uri, { retries: 1, interval: 500 });
  });
  after(async () => {
    await legacy?.close();
    await producer.close();
    await consumer.close();
  });

  test('publish/subscribe entre serviços, com confirmação do broker', async () => {
    const id = crypto.randomUUID();
    await producer.publish('it-events', 'items.created', event(id), { messageId: id });
    await producer.publish('it-events', 'other.created', event('não assinado'));
    await waitUntil(async () => ids(), list => list.includes(id), 10_000);
    assert.ok(!ids().includes('não assinado'));
  });

  test('RPC: resposta, erro do recurso e recurso inexistente (sem esperar o timeout)', async () => {
    assert.equal(await producer.executeResource('it-consumer', 'items.sum', 2, 3), 5);
    await assert.rejects(producer.executeResource('it-consumer', 'items.fail'), /^Error: item inexistente$/);
    const start = Date.now();
    await assert.rejects(producer.executeResource('it-consumer', 'items.nao-existe'), /Recurso RPC indisponível/);
    assert.ok(Date.now() - start < 2000, 'falha imediata, sem esperar o timeout de RPC');
  });

  describe('compatibilidade com serviços que usam a amqp-client-node', () => {
    test('eles chamam o RPC deste serviço (resposta e erro)', async () => {
      const rpc = { exchange: { type: 'direct', durable: true }, rpcTimeout: 5000 };
      assert.equal(await legacy.rpcClient('it-consumer.rpc', 'items.sum', [4, 5], rpc), 9);
      await assert.rejects(legacy.rpcClient('it-consumer.rpc', 'items.fail', [], rpc), /item inexistente/);
    });

    test('este serviço chama o RPC deles', async () => {
      const server = legacy.createRpcServer('it-legacy.rpc', 'it-legacy.rpc', [], { exchange: { type: 'direct', durable: true }, queue: { expires: 5000 } });
      server.addResource('legacy.echo', (value: unknown) => ({ echo: value }));
      await server.start();
      assert.deepEqual(await producer.executeResource('it-legacy', 'legacy.echo', 'oi'), { echo: 'oi' });
    });

    test('eles recebem o que este serviço publica, e este serviço recebe o que eles publicam', async () => {
      const theirs: unknown[] = [];
      await legacy.sub('it-legacy', 'it-events', 'items.legacy', message => {
        theirs.push(message.content);
        message.ack();
      }, { ...legacyOptions, queue: { durable: true }, consumer: { noAck: false } });
      const fromUs = crypto.randomUUID();
      await producer.publish('it-events', 'items.legacy', event(fromUs));
      await waitUntil(async () => theirs.length, n => n > 0, 10_000);
      assert.equal((theirs[0] as { item: { id: string } }).item.id, fromUs);

      const fromThem = crypto.randomUUID();
      await legacy.pub('it-events', 'items.created', { content: event(fromThem) }, legacyOptions);
      await waitUntil(async () => ids(), list => list.includes(fromThem), 10_000);
    });
  });
});
