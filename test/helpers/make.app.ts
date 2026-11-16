import { buildContainer } from '../../src/di/container.ts';
import { loadEnv } from '../../src/di/env.ts';
import { createApp } from '../../src/main/app.ts';

/** Monta uma instância completa da aplicação, respeitando REPOSITORY_DRIVER / QUEUE_DRIVER do ambiente. */
export async function makeApp() {
  // relatório rápido nos testes
  const env = loadEnv({ ...process.env, REPORT_DURATION_MS: process.env.REPORT_DURATION_MS ?? '50' });
  const container = await buildContainer(env);
  return { app: createApp(container), container, close: () => container.close() };
}
