import { setTimeout as sleep } from 'node:timers/promises';

/** Repete `read` até `isDone` ser verdadeiro ou estourar o tempo. Imita o cliente que consulta o status. */
export async function waitUntil<T>(
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!isDone(last)) {
    if (Date.now() > deadline) throw new Error(`timeout aguardando a condição (último valor: ${JSON.stringify(last)})`);
    await sleep(25);
    last = await read();
  }
  return last;
}
