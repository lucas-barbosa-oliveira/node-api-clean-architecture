import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import type { IntegrationEvent } from '../../src/application/port/event.bus.ts';
import { RabbitMqEventBus } from '../../src/infrastructure/eventbus/rabbitmq.event.bus.ts';
import { waitUntil } from '../helpers/wait.until.ts';

// Só roda com um RabbitMQ disponível (npm run docker:infra && npm run test:docker).
// O "outro microsserviço" é simulado com o amqplib direto: a amqp-client-node ignora mensagens publicadas
// por conexões do mesmo processo (receiveFromYourself), então dois barramentos aqui não se enxergariam no pub/sub.
describe('RabbitMQ (requer EVENT_BUS_DRIVER=rabbitmq)', { skip: process.env.EVENT_BUS_DRIVER !== 'rabbitmq' }, () => {
  const uri = process.env.RABBITMQ_URI as string;
  const producer = new RabbitMqEventBus({ uri, service: 'it-producer' });
  const consumer = new RabbitMqEventBus({ uri, service: 'it-consumer' });
  const received: IntegrationEvent[] = [];
  const published: IntegrationEvent[] = [];
  let raw: ChannelModel;
  let channel: Channel;

  before(async () => {
    // o "outro serviço": uma fila temporária que recebe tudo o que o producer publica em it-events
    raw = await connect(uri);
    channel = await raw.createChannel();
    await channel.assertExchange('it-events', 'topic', { durable: true });
    const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true });
    await channel.bindQueue(queue, 'it-events', 'items.#');
    await channel.consume(queue, message => {
      if (message) published.push(JSON.parse(message.content.toString()));
    }, { noAck: true });

    consumer.subscribe({
      eventName: 'ItemCreatedEvent',
      exchange: 'it-events',
      routingKey: 'items.*',
      handle: async event => { received.push(event); },
    });
    consumer.provideResource({ name: 'items.sum', handle: async (a, b) => Number(a) + Number(b) });
    consumer.provideResource({ name: 'items.fail', handle: async () => { throw new Error('item inexistente'); } });
    consumer.start();
    // publica antes de conectar: o evento fica no buffer e é enviado quando a conexão abrir
    await producer.publish('it-events', 'items.created', event('buffered'));
    producer.start();
    await waitUntil(async () => producer.isConnected && consumer.isConnected, Boolean, 15_000);
  });
  after(async () => {
    await raw.close();
    await producer.close();
    await consumer.close();
  });

  const event = (id: string): IntegrationEvent => ({ event_name: 'ItemCreatedEvent', timestamp: new Date().toISOString(), item: { id } });
  const ids = () => received.map(e => (e.item as { id: string }).id);

  test('publish: chega ao outro serviço, inclusive o evento que estava no buffer', async () => {
    const id = crypto.randomUUID();
    await producer.publish('it-events', 'items.created', event(id));
    const pubIds = () => published.map(e => (e.item as { id: string }).id);
    await waitUntil(async () => pubIds(), list => list.includes(id) && list.includes('buffered'), 10_000);
    assert.equal(published.find(e => (e.item as { id: string }).id === id)?.event_name, 'ItemCreatedEvent');
  });

  test('subscribe: recebe só a exchange e routing key assinadas', async () => {
    const id = crypto.randomUUID();
    const send = (routingKey: string, itemId: string) => channel.publish('it-events', routingKey,
      Buffer.from(JSON.stringify(event(itemId))), { contentType: 'application/json' });
    send('other.created', 'não assinado');
    send('items.created', id);
    await waitUntil(async () => ids(), list => list.includes(id), 10_000);
    assert.ok(!ids().includes('não assinado'));
  });

  test('RPC: resposta e erro do recurso chegam a quem chamou', async () => {
    // o servidor RPC pode demorar um instante para registrar as filas depois da conexão
    const call = () => producer.executeResource('it-consumer', 'items.sum', 2, 3).catch(() => undefined);
    const sum = await waitUntil(call, value => value !== undefined, 10_000);
    assert.equal(sum, 5);
    await assert.rejects(producer.executeResource('it-consumer', 'items.fail'), /item inexistente/);
  });
});
