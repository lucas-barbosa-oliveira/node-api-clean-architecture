import { loadEnv, type TlsSettings } from '../../src/di/env.ts';
import { currentSecret } from '../../src/di/secrets.ts';
import { withCredentials } from '../../src/infrastructure/eventbus/rabbitmq.event.bus.ts';
import { readTlsClientOptions } from '../../src/infrastructure/security/tls.ts';

/**
 * TLS e credenciais das conexões diretas dos testes de integração, conforme o ambiente:
 * test:docker (nada), test:docker:tls (TLS) e test:docker:vault (TLS + credenciais entregues pelo Vault Agent).
 */
const env = loadEnv(process.env);

export const envTls: TlsSettings = env.tls;

export function mongoCredentials() {
  if (env.REPOSITORY_DRIVER !== 'mongo') return undefined;
  const username = currentSecret(env, 'MONGO_USERNAME');
  const password = currentSecret(env, 'MONGO_PASSWORD');
  return username && password ? { username, password, authSource: env.MONGO_AUTH_SOURCE } : undefined;
}

/** Opções do Mongoose para conexões diretas (ex.: apagar o banco de teste). */
export function mongoConnectOptions() {
  const credentials = mongoCredentials();
  return {
    ...(envTls.mongo && { tls: true, ...readTlsClientOptions(envTls.mongo) }),
    ...(credentials && { auth: { username: credentials.username, password: credentials.password }, authSource: credentials.authSource }),
  };
}

export function redisCredentials() {
  const username = currentSecret(env, 'REDIS_USERNAME');
  const password = currentSecret(env, 'REDIS_PASSWORD');
  return username || password ? { username, password } : undefined;
}

/** RABBITMQ_URI com as credenciais do ambiente (no modo Vault elas vêm em arquivo). */
export function rabbitUri(): string {
  const uri = process.env.RABBITMQ_URI as string;
  return withCredentials(uri, { username: currentSecret(env, 'RABBITMQ_USERNAME'), password: currentSecret(env, 'RABBITMQ_PASSWORD') });
}

export const influxToken = () => currentSecret(env, 'INFLUX_TOKEN') ?? '';
