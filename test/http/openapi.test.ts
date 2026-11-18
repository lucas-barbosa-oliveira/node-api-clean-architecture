import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import request, { type Response } from 'supertest';
import { parse as parseYaml } from 'yaml';
import { ADMIN, createUser, login, loginAsAdmin, makeApp, type TestUser } from '../helpers/make.app.ts';
import { waitForJob } from '../helpers/wait.for.job.ts';
import { Totp } from '../../src/infrastructure/security/totp.ts';

type Doc = { paths: Record<string, Record<string, { responses: Record<string, any> }>>; components: Record<string, any> };

/** Rotas registradas no Express (método + caminho no formato do OpenAPI: /jobs/{id}). */
function expressRoutes(stack: any[], out: string[] = []): string[] {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push(`${method} ${String(layer.route.path).replace(/:(\w+)/g, '{$1}')}`);
      }
    } else if (layer.handle?.stack) {
      expressRoutes(layer.handle.stack, out);
    }
  }
  return out;
}

describe('Documentação OpenAPI', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let doc: Doc;
  let validateAgainst: (res: Response, method: string, path: string) => void;

  before(async () => {
    ctx = await makeApp();
    doc = (await request(ctx.app).get('/reference/openapi.json').expect(200)).body;

    // as respostas são validadas contra o próprio documento servido pela API (os $ref apontam para ele)
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajvFormats.default(ajv); // pacote CommonJS: a função fica em .default
    ajv.addSchema({ ...doc, $id: 'openapi.json' });
    const pointer = (...parts: string[]) => parts.map(p => p.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');

    validateAgainst = (res, method, path) => {
      const operation = doc.paths[path]?.[method];
      assert.ok(operation, `${method.toUpperCase()} ${path} não está documentado`);
      const documented = operation.responses[String(res.status)];
      assert.ok(documented, `${method.toUpperCase()} ${path}: status ${res.status} não documentado (${JSON.stringify(res.body)})`);

      const responsePath = documented.$ref
        ? documented.$ref.replace('#/', '').split('/')
        : ['paths', path, method, 'responses', String(res.status)];
      const response = documented.$ref ? doc.components.responses[responsePath.at(-1) as string] : documented;
      assert.ok(res.headers['x-request-id'], 'toda resposta traz X-Request-ID');
      if (response.headers?.['X-Total-Count']) assert.ok(res.headers['x-total-count'] !== undefined, 'X-Total-Count');
      if (!response.content) {
        assert.ok(!res.text, `${method.toUpperCase()} ${path} ${res.status}: corpo não documentado`);
        return;
      }
      const validate = ajv.getSchema(`openapi.json#/${pointer(...responsePath, 'content', 'application/json', 'schema')}`);
      assert.ok(validate, `schema de ${method.toUpperCase()} ${path} ${res.status}`);
      assert.ok(
        validate(res.body),
        `${method.toUpperCase()} ${path} ${res.status} fora do contrato: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(res.body)}`,
      );
    };
  });
  after(() => ctx.close());

  test('é um OpenAPI 3.1 válido', async () => {
    await SwaggerParser.validate(structuredClone(doc) as never);
  });

  test('toda rota do Express está documentada, e nada documentado deixou de existir', () => {
    const routes = expressRoutes((ctx.app as any).router.stack).filter(route => !route.includes('/reference'));
    const documented = Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map(method => `${method} ${path}`));
    assert.deepEqual([...documented].sort(), [...routes].sort());
  });

  test('cada rota informa quem pode chamar', () => {
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops) as [string, any][]) {
        assert.match(op.description, /\*\*(Acesso|Escopo):\*\*/, `${method} ${path}`);
      }
    }
  });

  test('Swagger UI, YAML e arquivos estáticos são servidos', async () => {
    const page = await request(ctx.app).get('/reference').expect(200);
    assert.match(page.text, /swagger-ui-bundle\.js/);
    await request(ctx.app).get('/reference/init.js').expect(200).expect('Content-Type', /javascript/);
    await request(ctx.app).get('/reference/assets/swagger-ui-bundle.js').expect(200);
    await request(ctx.app).get('/reference/assets/swagger-ui.css').expect(200);
    const yaml = await request(ctx.app).get('/reference/openapi.yaml').expect(200).expect('Content-Type', /yaml/);
    assert.deepEqual(parseYaml(yaml.text), doc);
  });

  describe('as respostas reais seguem o documento', () => {
    let admin: string;
    let manager: TestUser;
    let client: TestUser;

    before(async () => {
      admin = await loginAsAdmin(ctx.app);
      manager = await createUser(ctx.app, admin, 'manager');
      client = await createUser(ctx.app, admin, 'client');
    });

    const as = (token: string) => ({
      get: (url: string) => request(ctx.app).get(url).auth(token, { type: 'bearer' }),
      post: (url: string) => request(ctx.app).post(url).auth(token, { type: 'bearer' }),
      delete: (url: string) => request(ctx.app).delete(url).auth(token, { type: 'bearer' }),
    });

    test('sistema, autenticação e sessões', async () => {
      validateAgainst(await request(ctx.app).get('/health'), 'get', '/health');
      validateAgainst(await request(ctx.app).get('/.well-known/jwks.json'), 'get', '/.well-known/jwks.json');

      const loginRes = await request(ctx.app).post('/auth/login').send(ADMIN);
      validateAgainst(loginRes, 'post', '/auth/login');
      validateAgainst(await request(ctx.app).post('/auth/login').send({ email: ADMIN.email, password: 'errada' }), 'post', '/auth/login');
      validateAgainst(await request(ctx.app).post('/auth/login').send({}), 'post', '/auth/login');

      const refreshed = await request(ctx.app).post('/auth/refresh').send({ refresh_token: loginRes.body.refresh_token });
      validateAgainst(refreshed, 'post', '/auth/refresh');

      const sessions = await as(refreshed.body.access_token).get('/auth/sessions');
      validateAgainst(sessions, 'get', '/auth/sessions');
      validateAgainst(await as(admin).delete(`/auth/sessions/${crypto.randomUUID()}`), 'delete', '/auth/sessions/{id}');

      const other = await login(ctx.app, client.email, client.password);
      validateAgainst(await as(admin).delete(`/users/${client.id}/sessions`), 'delete', '/users/{id}/sessions');
      validateAgainst(await as(other).get('/users/me'), 'get', '/users/me'); // sessão derrubada: 401
      client.token = await login(ctx.app, client.email, client.password);

      const toLogout = await login(ctx.app, manager.email, manager.password);
      validateAgainst(await as(toLogout).post('/auth/logout-all'), 'post', '/auth/logout-all');
      const single = await login(ctx.app, manager.email, manager.password);
      validateAgainst(await as(single).post('/auth/logout'), 'post', '/auth/logout');
      manager.token = await login(ctx.app, manager.email, manager.password);
    });

    test('MFA: configuração, login em duas etapas, desativação e redefinição', async () => {
      const totp = new Totp();
      const user = await createUser(ctx.app, admin, 'client');
      validateAgainst(await as(user.token).get('/auth/mfa'), 'get', '/auth/mfa');

      const setupRes = await as(user.token).post('/auth/mfa/setup');
      validateAgainst(setupRes, 'post', '/auth/mfa/setup');
      validateAgainst(await as(user.token).post('/auth/mfa/enable').send({ code: '000000' }), 'post', '/auth/mfa/enable');
      const enabled = await as(user.token).post('/auth/mfa/enable').send({ code: totp.codeAt(setupRes.body.secret) });
      validateAgainst(enabled, 'post', '/auth/mfa/enable');
      validateAgainst(await as(user.token).post('/auth/mfa/setup'), 'post', '/auth/mfa/setup'); // 409

      const challenge = await request(ctx.app).post('/auth/login').send({ email: user.email, password: user.password });
      validateAgainst(challenge, 'post', '/auth/login');
      const verify = (code: string) => request(ctx.app).post('/auth/mfa/verify').send({ mfa_token: challenge.body.mfa_token, code });
      validateAgainst(await verify('000000'), 'post', '/auth/mfa/verify');
      validateAgainst(await request(ctx.app).post('/auth/mfa/verify').send({}), 'post', '/auth/mfa/verify');
      const tokens = await verify(totp.codeAt(setupRes.body.secret, new Date(Date.now() + 30_000)));
      validateAgainst(tokens, 'post', '/auth/mfa/verify');

      const mfaToken = tokens.body.access_token;
      validateAgainst(await as(mfaToken).post('/auth/mfa/recovery-codes').send({ code: '000000' }), 'post', '/auth/mfa/recovery-codes');
      validateAgainst(await as(mfaToken).post('/auth/mfa/disable').send({ code: enabled.body.recovery_codes[0] }), 'post', '/auth/mfa/disable');
      validateAgainst(await as(mfaToken).post('/auth/mfa/disable').send({ code: enabled.body.recovery_codes[1] }), 'post', '/auth/mfa/disable');

      validateAgainst(await as(admin).delete(`/users/${user.id}/mfa`), 'delete', '/users/{id}/mfa'); // 409: sem MFA
      validateAgainst(await as(admin).delete(`/users/${crypto.randomUUID()}/mfa`), 'delete', '/users/{id}/mfa');
      validateAgainst(await as(mfaToken).delete(`/users/${user.id}/mfa`), 'delete', '/users/{id}/mfa'); // 403
      await as(mfaToken).post('/auth/mfa/setup').expect(200);
      validateAgainst(await as(admin).delete(`/users/${user.id}/mfa`), 'delete', '/users/{id}/mfa');
    });

    test('usuários', async () => {
      const created = await as(admin).post('/users').send({ name: 'Novo', email: `${crypto.randomUUID()}@t.com`, password: 'senha-forte', role: 'client' });
      validateAgainst(created, 'post', '/users');
      validateAgainst(await as(admin).post('/users').send({ name: 'Dup', email: created.body.email, password: 'senha-forte', role: 'client' }), 'post', '/users');
      validateAgainst(await as(manager.token).post('/users').send({}), 'post', '/users'); // 403

      validateAgainst(await as(admin).get('/users?limit=5&sort=-createdAt'), 'get', '/users');
      validateAgainst(await as(admin).get('/users?senha=1'), 'get', '/users');
      validateAgainst(await as(client.token).get('/users/me'), 'get', '/users/me');
      validateAgainst(await as(admin).get(`/users/${client.id}`), 'get', '/users/{id}');
      validateAgainst(await as(client.token).get(`/users/${manager.id}`), 'get', '/users/{id}');
      validateAgainst(await as(manager.token).get('/clients'), 'get', '/clients');
    });

    test('jobs', async () => {
      const report = await as(manager.token).post('/reports').send({ clientId: client.id, month: '2026-10' });
      validateAgainst(report, 'post', '/reports');
      validateAgainst(await as(manager.token).post('/reports').send({ clientId: client.id, month: 'outubro' }), 'post', '/reports');
      await waitForJob(ctx.app, manager.token, report.body.id);

      validateAgainst(await as(manager.token).get(`/jobs/${report.body.id}`), 'get', '/jobs/{id}');
      validateAgainst(await as(client.token).get('/jobs?status=succeeded'), 'get', '/jobs');
      validateAgainst(await as(manager.token).get(`/jobs/${crypto.randomUUID()}`), 'get', '/jobs/{id}');
    });

    test('dispositivos e passagens', async () => {
      const code = await as(client.token).post(`/clients/${client.id}/pairing-codes`);
      validateAgainst(code, 'post', '/clients/{clientId}/pairing-codes');
      validateAgainst(await as(client.token).post(`/clients/${manager.id}/pairing-codes`), 'post', '/clients/{clientId}/pairing-codes');

      const claim = await request(ctx.app).post('/devices/claim').send({ code: code.body.code, hardwareId: '24:6F:28:AB:CD:EF', firmware: '1.0.0' });
      validateAgainst(claim, 'post', '/devices/claim');
      validateAgainst(await request(ctx.app).post('/devices/claim').send({ code: code.body.code }), 'post', '/devices/claim');

      const device = as(claim.body.access_token);
      const batch = {
        clientId: client.id,
        events: [{ eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), direction: 'in', sequence: 1 }],
        device: { firmware: '1.0.0', uptimeSeconds: 10, rssi: -60 },
      };
      validateAgainst(await device.post(`/devices/${claim.body.device_id}/passages`).send(batch), 'post', '/devices/{deviceId}/passages');
      validateAgainst(await device.post(`/devices/${claim.body.device_id}/passages`).send({ ...batch, clientId: manager.id }), 'post', '/devices/{deviceId}/passages');
      validateAgainst(await device.get('/devices'), 'get', '/devices'); // token de dispositivo em outra rota: 403

      validateAgainst(await as(client.token).get('/devices'), 'get', '/devices');
      validateAgainst(await as(client.token).get('/passages?direction=in'), 'get', '/passages');
      validateAgainst(await as(client.token).get('/passages/summary?window=1h&period=1d'), 'get', '/passages/summary');
      validateAgainst(await as(client.token).get('/passages/summary?window=1s'), 'get', '/passages/summary');

      validateAgainst(await as(client.token).delete(`/devices/${claim.body.device_id}`), 'delete', '/devices/{id}');
      validateAgainst(await as(client.token).delete(`/devices/${crypto.randomUUID()}`), 'delete', '/devices/{id}');
    });
  });
});
