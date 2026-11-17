import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBusUnavailableError, type IEventBus, type IntegrationEvent } from '../../src/application/port/event.bus.ts';
import { InMemoryOutbox } from '../../src/infrastructure/outbox/in.memory.outbox.ts';
import { OutboxRelay } from '../../src/infrastructure/outbox/outbox.relay.ts';
import { waitUntil } from '../helpers/wait.until.ts';

/** Barramento de teste: conectado ou não, e falhando nas primeiras N publicações. */
function fakeBus(options: { connected?: boolean; failFirst?: number } = {}) {
  const published: { exchange: string; routingKey: string; event: IntegrationEvent; messageId?: string }[] = [];
  let failures = options.failFirst ?? 0;
  const bus = {
    isConnected: options.connected ?? true,
    published,
    async publish(exchange: string, routingKey: string, event: IntegrationEvent, opts: { messageId?: string } = {}) {
      if (!bus.isConnected) throw new EventBusUnavailableError();
      if (failures-- > 0) throw new Error('nack');
      published.push({ exchange, routingKey, event, messageId: opts.messageId });
    },
  };
  return bus as typeof bus & IEventBus;
}

const message = (name: string) => ({ exchange: 'users', routingKey: 'users.created', event: { event_name: name, timestamp: new Date().toISOString() } });

describe('Outbox', () => {
  test('o relay publica em ordem, com o id do registro como messageId, e esvazia o outbox', async () => {
    const outbox = new InMemoryOutbox();
    const bus = fakeBus();
    const relay = new OutboxRelay({ store: outbox, bus, pollIntervalMs: 20 });
    outbox.onAdd(() => relay.notify());
    await outbox.add(message('A'), message('B'));
    relay.start();
    await waitUntil(async () => bus.published.length, n => n === 2);
    await relay.stop();
    assert.deepEqual(bus.published.map(p => p.event.event_name), ['A', 'B']);
    assert.ok(bus.published.every(p => p.messageId));
    assert.equal((await outbox.stats()).pending, 0);
  });

  test('com o barramento fora do ar, nada se perde: publica quando a conexão volta', async () => {
    const outbox = new InMemoryOutbox();
    const bus = fakeBus({ connected: false });
    const relay = new OutboxRelay({ store: outbox, bus, pollIntervalMs: 20 });
    relay.start();
    await outbox.add(message('A'));
    await new Promise(r => setTimeout(r, 100));
    assert.equal(bus.published.length, 0);
    assert.equal((await outbox.stats()).pending, 1);

    bus.isConnected = true;
    await waitUntil(async () => bus.published.length, n => n === 1);
    await relay.stop();
  });

  test('falha na publicação: tenta de novo com espera crescente', async () => {
    const outbox = new InMemoryOutbox();
    const bus = fakeBus({ failFirst: 2 });
    const relay = new OutboxRelay({ store: outbox, bus, pollIntervalMs: 20, maxBackoffMs: 50 });
    await outbox.add(message('A'));
    relay.start();
    await waitUntil(async () => bus.published.length, n => n === 1, 5000);
    await relay.stop();
    assert.equal(bus.published[0].event.event_name, 'A');
  });

  test('dois relays (duas instâncias) não publicam o mesmo evento', async () => {
    const outbox = new InMemoryOutbox();
    const bus = fakeBus();
    for (let i = 0; i < 50; i++) await outbox.add(message(`E${i}`));
    const relays = [1, 2].map(() => new OutboxRelay({ store: outbox, bus, pollIntervalMs: 10, batchSize: 5 }));
    relays.forEach(relay => relay.start());
    await waitUntil(async () => bus.published.length, n => n >= 50);
    await Promise.all(relays.map(relay => relay.stop()));
    assert.equal(new Set(bus.published.map(p => p.messageId)).size, 50);
    assert.equal(bus.published.length, 50);
  });
});
