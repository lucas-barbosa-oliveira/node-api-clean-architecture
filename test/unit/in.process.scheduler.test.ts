import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { InProcessScheduler } from '../../src/background/scheduler/in.process.scheduler.ts';

test('executa tasks de startup e uma task que falha não derruba as outras', async () => {
  const errors = mock.method(console, 'error', () => {});
  try {
    let ran = 0;
    const scheduler = new InProcessScheduler([
      { name: 'ok', runOnStartup: true, run: async () => { ran++; } },
      { name: 'boom', runOnStartup: true, run: async () => { throw new Error('x'); } },
    ]);
    await scheduler.start();
    await scheduler.stop(); // espera as execuções em andamento
    assert.equal(ran, 1);
    assert.equal(errors.mock.callCount(), 1);
  } finally {
    errors.mock.restore();
  }
});

test('stop() cancela os agendamentos e sinaliza o AbortSignal', async () => {
  let aborted = false;
  const scheduler = new InProcessScheduler([
    {
      name: 'longa',
      runOnStartup: true,
      schedule: '0 3 * * *',
      run: async signal => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }));
      },
    },
  ]);
  await scheduler.start();
  await scheduler.stop();
  assert.equal(aborted, true);
});
