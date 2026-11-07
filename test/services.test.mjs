import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CoreAiModel,
  CoreBackendClient,
  ServiceCredentials,
  createServiceStack,
} from '../src/services.mjs';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const reply = (data) =>
  new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
const env = {
  CORE_TOKEN: 'service-token-private',
  SERVICE_KEY: 'gateway-private',
  APP_ID: 'conversation-roleplay',
  APP_KEY: 'app-private',
};
const services = {
  required: ['coreBackend', 'coreAi'],
  coreBackend: {
    baseUrl: 'https://core.example',
    organizationId: orgId,
    auth: { bearerEnv: 'CORE_TOKEN' },
  },
  coreAi: {
    baseUrl: 'https://ai.example',
    serviceKeyEnv: 'SERVICE_KEY',
    appIdEnv: 'APP_ID',
    appKeyEnv: 'APP_KEY',
    model: 'auto',
    jsonMode: true,
  },
};

test('Core AI binds inference to independently resolved Core identity and app credentials', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (new URL(url).pathname === '/auth/me')
      return reply({ org_id: orgId, user_id: userId, org_role: 'member' });
    return reply({ choices: [{ message: { content: '{"roles":[]}' } }] });
  };
  const backend = new CoreBackendClient(services.coreBackend, {
    env,
    fetchImpl,
  });
  const model = new CoreAiModel(services.coreAi, backend, { env, fetchImpl });
  assert.deepEqual(
    await model.complete('enhance', {
      roles: [],
      org_id: 'untrusted-persona-tenant',
    }),
    { roles: [] },
  );
  assert.equal(requests[0].url, 'https://core.example/auth/me');
  assert.equal(
    requests[0].options.headers.Authorization,
    `Bearer ${env.CORE_TOKEN}`,
  );
  const request = requests[1];
  assert.equal(request.url, 'https://ai.example/v1/chat/completions');
  assert.equal(
    request.options.headers.Authorization,
    `Bearer ${env.SERVICE_KEY}`,
  );
  assert.equal(request.options.headers['X-App-Key'], env.APP_KEY);
  assert.equal(request.options.headers['X-App-Id'], env.APP_ID);
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.model_selection, {
    task_family: 'chat',
    local_only: false,
  });
  assert.equal(body.metadata.org_id, orgId);
  assert.equal(body.metadata.user_id, userId);
  assert.equal(body.metadata.purpose, 'enhance');
  assert.equal(body.stream, false);
  assert.equal(body.response_format.type, 'json_object');
  assert.ok(
    Object.values(body.metadata).every((value) => typeof value === 'string'),
  );
});

test('foreign Core organization stops inference before any model or product request', async () => {
  let calls = 0;
  const stack = createServiceStack(
    { services },
    {
      env,
      fetchImpl: async () => {
        calls++;
        return reply({ org_id: userId, user_id: userId });
      },
    },
  );
  await assert.rejects(
    stack.model('actorModel').complete('enhance', {}),
    /organization differs/,
  );
  assert.equal(calls, 1);
});

test('OIDC credentials refresh before expiry, coalesce mints and never follow redirects', async () => {
  let time = 1000,
    calls = 0;
  const credentials = new ServiceCredentials(
    {
      oauth: {
        tokenUrl: 'https://identity.example/realm/token',
        clientId: 'lab',
        clientSecretEnv: 'CLIENT_SECRET',
        scope: 'openid',
      },
    },
    {
      env: { CLIENT_SECRET: 'private' },
      clock: () => time,
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(options.redirect, 'error');
        assert.equal(options.method, 'POST');
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('grant_type'), 'client_credentials');
        assert.equal(form.get('client_secret'), 'private');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return reply({ access_token: `minted-${calls}`, expires_in: 100 });
      },
    },
  );
  assert.deepEqual(
    await Promise.all([credentials.token(), credentials.token()]),
    ['minted-1', 'minted-1'],
  );
  time += 79000;
  assert.equal(await credentials.token(), 'minted-1');
  time += 2000;
  assert.equal(await credentials.token(), 'minted-2');
  assert.equal(calls, 2);
});

test('required service outages block preflight; probes do not claim inference or HAI repair', async () => {
  const config = {
    services: {
      ...services,
      required: ['coreBackend', 'coreAi', 'hai'],
      hai: {
        baseUrl: 'https://hai.example',
        enabled: true,
        contractVerified: true,
        headersEnv: { 'x-app-id': 'APP_ID', 'x-app-key': 'APP_KEY' },
      },
    },
  };
  const calls = [];
  const stack = createServiceStack(config, {
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (new URL(url).pathname === '/auth/me')
        return reply({ org_id: orgId, user_id: userId });
      return reply({
        paths: {
          '/v1/chat/completions': { post: {} },
          '/v1/tasks': { post: {} },
          '/v1/runs/{run_id}': { get: {} },
        },
      });
    },
  });
  const report = await stack.check();
  assert.equal(report.ready, true);
  assert.equal(report.services.coreAi.inferenceVerified, false);
  assert.equal(report.services.hai.repairVerified, false);
  assert.ok(calls.every((call) => call.method === 'GET'));
  const outage = createServiceStack(
    { services },
    {
      env,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    },
  );
  await assert.rejects(outage.preflight(), /shared services are not ready/);
  assert.equal((await outage.check()).ready, false);
});

test('OAuth transport rejects remote cleartext and does not leak rejected token response content', async () => {
  let calls = 0;
  const credentials = new ServiceCredentials(
    {
      oauth: {
        tokenUrl: 'http://remote.example/token',
        clientId: 'lab',
        clientSecretEnv: 'SECRET',
      },
    },
    {
      env: { SECRET: 'private-value' },
      fetchImpl: async () => {
        calls++;
        throw new Error('private-value');
      },
    },
  );
  await assert.rejects(credentials.token(), /must use HTTPS/);
  assert.equal(calls, 0);
});
