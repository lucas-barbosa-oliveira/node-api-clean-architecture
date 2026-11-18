import type { Express } from 'express';
import request from 'supertest';
import { buildContainer } from '../../src/di/container.ts';
import { loadEnv } from '../../src/di/env.ts';
import { createApp } from '../../src/main/app.ts';

export const ADMIN = { email: 'admin@teste.com', password: 'admin-senha-teste' };

/** Monta uma instância completa da aplicação, respeitando REPOSITORY_DRIVER / QUEUE_DRIVER do ambiente. */
export async function makeApp(overrides: Record<string, string> = {}) {
  // banco separado: os testes não misturam dados (nem eventos pendentes no outbox) com a API de desenvolvimento
  const mongoDb = overrides.MONGO_DB ?? `${process.env.MONGO_DB ?? 'app'}_test`;
  const env = loadEnv({
    ...process.env,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent', // TEST_LOG_LEVEL=info mostra os logs da aplicação nos testes
    REPORT_DURATION_MS: '50', // relatório rápido nos testes (ignora o valor do .env.docker)
    MONGO_DB: mongoDb,
    // a fila acompanha o banco: um worker de outro banco (a API rodando ao lado, ou outro arquivo de teste
    // com banco próprio) não pega jobs que não consegue encontrar
    QUEUE_PREFIX: `bull-${mongoDb}`,
    // bancos de teste são criados na hora: os índices também (no modo Vault, a API usa npm run db:migrate)
    MONGO_AUTO_INDEX: 'true',
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ...overrides,
  });
  const container = await buildContainer(env);
  await container.ensureAdmin();
  return { app: createApp(container), container, close: () => container.close() };
}

export async function login(app: Express, email: string, password: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login falhou (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.access_token;
}

export const loginAsAdmin = (app: Express) => login(app, ADMIN.email, ADMIN.password);

export type TestUser = { id: string; email: string; password: string; token: string };

/** O administrador cadastra um gestor ou cliente, que em seguida faz login. */
export async function createUser(app: Express, adminToken: string, role: 'manager' | 'client'): Promise<TestUser> {
  const email = `${crypto.randomUUID()}@teste.com`;
  const password = 'senha-de-teste';
  const res = await request(app)
    .post('/users')
    .auth(adminToken, { type: 'bearer' })
    .send({ name: `Usuário ${role}`, email, password, role });
  if (res.status !== 201) throw new Error(`cadastro falhou (${res.status}): ${JSON.stringify(res.body)}`);
  return { id: res.body.id, email, password, token: await login(app, email, password) };
}
