/** Shared platform services. Core Backend owns identity; Core AI owns inference; HAI owns repair proposals. */
import { JsonChatModel } from './model.mjs';
import { HaiRepairAdapter } from './repair.mjs';
import { KoraOneIncidentClient } from './incidents.mjs';
import { assert, envHeaders, jsonRequest, uuid } from './util.mjs';

export function setting(config, key, env = process.env, fallback) {
  const value = config?.[`${key}Env`]
    ? env[config[`${key}Env`]]
    : (config?.[key] ?? fallback);
  assert(
    typeof value === 'string' && value.trim() && !/[\r\n]/.test(value),
    `Configure ${config?.[`${key}Env`] ?? key}`,
  );
  return value.trim();
}

function endpoint(config, path, env) {
  const base = new URL(setting(config, 'baseUrl', env));
  assert(
    ['https:', 'http:'].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash &&
      ['/', ''].includes(base.pathname),
    'Service baseUrl must be an HTTP origin',
  );
  assert(
    path.startsWith('/') && !path.startsWith('//'),
    'Service paths must be relative',
  );
  return new URL(path, base);
}

/** Service identity uses an operator-provided bearer or canonical OIDC client_credentials, never a forged JWT. */
export class ServiceCredentials {
  constructor(
    config = {},
    { env = process.env, fetchImpl = fetch, clock = Date.now } = {},
  ) {
    this.config = config;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
  }
  async token(signal) {
    if (this.config.bearerEnv)
      return setting(this.config, 'bearer', this.env).replace(/^Bearer /i, '');
    const oauth = this.config.oauth;
    assert(oauth, 'Configure a bearerEnv or oauth service identity');
    if (this.cached && this.cached.until > this.clock())
      return this.cached.value;
    if (!this.pending)
      this.pending = this.mint(signal).finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  async mint(signal) {
    const oauth = this.config.oauth;
    const tokenUrl = new URL(setting(oauth, 'tokenUrl', this.env));
    assert(
      tokenUrl.protocol === 'https:' ||
        (tokenUrl.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(tokenUrl.hostname)),
      'OIDC tokenUrl must use HTTPS or loopback development',
    );
    assert(
      !tokenUrl.username && !tokenUrl.password && !tokenUrl.hash,
      'Invalid OIDC token URL',
    );
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: setting(oauth, 'clientId', this.env),
      client_secret: setting(oauth, 'clientSecret', this.env),
    });
    if (oauth.scope || oauth.scopeEnv)
      form.set('scope', setting(oauth, 'scope', this.env));
    const timeout = AbortSignal.timeout(15000);
    let response;
    try {
      response = await this.fetchImpl(tokenUrl, {
        method: 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch {
      throw new Error(
        'OIDC token service unavailable; no product action was sent',
      );
    }
    assert(response.ok, `OIDC token service returned HTTP ${response.status}`);
    const data = await response.json();
    assert(
      typeof data.access_token === 'string' &&
        data.access_token.length > 0 &&
        Number.isFinite(data.expires_in) &&
        data.expires_in > 0,
      'OIDC token response is invalid',
    );
    const margin = Math.min(60000, (data.expires_in * 1000) / 5);
    this.cached = {
      value: data.access_token,
      until: this.clock() + data.expires_in * 1000 - margin,
    };
    return data.access_token;
  }
  async headers(signal) {
    return {
      ...envHeaders(this.config.headersEnv, this.env),
      Authorization: `Bearer ${await this.token(signal)}`,
    };
  }
}

export class CoreBackendClient {
  constructor(config, options = {}) {
    this.config = config;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.credentials = new ServiceCredentials(config.auth, options);
  }
  async identity({ signal, force = false } = {}) {
    if (!force && this.cached && this.cached.until > Date.now())
      return this.cached.identity;
    const headers = await this.credentials.headers(signal);
    if (this.config.organizationIdEnv || this.config.organizationId)
      headers['X-Organization-ID'] = setting(
        this.config,
        'organizationId',
        this.env,
      );
    const { data } = await jsonRequest(
      endpoint(this.config, this.config.identityPath ?? '/auth/me', this.env),
      { headers, signal, fetchImpl: this.fetchImpl, timeoutMs: 15000 },
    );
    const uuidPattern =
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    assert(
      uuidPattern.test(data.org_id) && uuidPattern.test(data.user_id),
      'Core Backend did not return canonical organization/user UUIDs',
    );
    if (this.config.organizationIdEnv || this.config.organizationId)
      assert(
        data.org_id === setting(this.config, 'organizationId', this.env),
        'Core Backend organization differs from the configured workspace',
      );
    const identity = {
      orgId: data.org_id,
      userId: data.user_id,
      orgRole: data.org_role ?? null,
    };
    this.cached = { until: Date.now() + 30000, identity };
    return identity;
  }
}

export class CoreAiModel extends JsonChatModel {
  constructor(config, coreBackend, options = {}) {
    super(
      {
        url: 'http://configured-core-ai.invalid',
        model: config.model ?? 'auto',
        jsonMode: config.jsonMode,
        timeoutMs: config.timeoutMs ?? 180000,
      },
      options,
    );
    assert(
      coreBackend,
      'Core AI requires Core Backend for canonical workspace identity',
    );
    this.serviceConfig = config;
    this.coreBackend = coreBackend;
    this.kind = 'core-ai';
  }
  async transport(purpose, payload, signal) {
    const identity = await this.coreBackend.identity({ signal });
    const request = await super.transport(purpose, payload);
    const config = this.serviceConfig;
    request.url = endpoint(config, '/v1/chat/completions', this.env);
    request.headers = {
      Authorization: `Bearer ${setting(config, 'serviceKey', this.env)}`,
      'X-App-Id': setting(config, 'appId', this.env),
      'X-App-Key': setting(config, 'appKey', this.env),
      'X-Product': 'conversation-roleplay',
    };
    request.body.stream = false;
    request.body.metadata = {
      source: 'conversation-roleplay',
      purpose,
      org_id: identity.orgId,
      user_id: identity.userId,
      request_id: uuid(),
    };
    if (request.body.model === 'auto')
      request.body.model_selection = {
        task_family:
          config.taskFamilies?.[purpose] ?? config.taskFamily ?? 'chat',
        local_only: config.localOnly ?? false,
        ...(config.qualityFloor === undefined
          ? {}
          : { quality_floor: config.qualityFloor }),
      };
    return request;
  }
}

export function createServiceStack(config = {}, options = {}) {
  const env = options.env ?? process.env;
  const services = config.services ?? {};
  const coreBackend = services.coreBackend
    ? new CoreBackendClient(services.coreBackend, options)
    : null;
  const hai = services.hai ?? config.hai;
  const haiConfig = hai
    ? { ...hai, ...(hai.baseUrlEnv ? { baseUrl: env[hai.baseUrlEnv] } : {}) }
    : undefined;
  const haiCredentials = hai?.auth
    ? new ServiceCredentials(hai.auth, options)
    : null;
  const repairAdapter = new HaiRepairAdapter(haiConfig, {
    ...options,
    ...(haiCredentials
      ? {
          getHeaders: async (signal) => ({
            ...envHeaders(hai.headersEnv, env),
            ...(await haiCredentials.headers(signal)),
          }),
        }
      : {}),
  });
  const koraOne = services.koraOne;
  const incidentCredentials = koraOne?.auth
    ? new ServiceCredentials(koraOne.auth, options)
    : null;
  const incidentClient = new KoraOneIncidentClient(
    koraOne
      ? {
          ...koraOne,
          baseUrl: koraOne.baseUrlEnv
            ? env[koraOne.baseUrlEnv]
            : koraOne.baseUrl,
        }
      : undefined,
    coreBackend,
    {
      ...options,
      ...(incidentCredentials
        ? { getHeaders: (signal) => incidentCredentials.headers(signal) }
        : {}),
    },
  );
  return {
    coreBackend,
    incidentClient,
    model(kind) {
      if (services.coreAi)
        return new CoreAiModel(
          { ...services.coreAi, ...(services.coreAi[kind] ?? {}) },
          coreBackend,
          options,
        );
      return new JsonChatModel(config[kind] ?? config.llm, options);
    },
    repairAdapter,
    async preflight() {
      const result = await this.check();
      assert(
        result.ready,
        'Required shared services are not ready; inspect /api/services or run doctor',
      );
      return coreBackend ? coreBackend.identity({ force: true }) : null;
    },
    async check() {
      const report = {};
      const run = async (name, operation) => {
        const start = performance.now();
        try {
          report[name] = {
            configured: true,
            ok: true,
            ...(await operation()),
            latencyMs: Math.round(performance.now() - start),
          };
        } catch (error) {
          report[name] = {
            configured: true,
            ok: false,
            error: error.message,
            latencyMs: Math.round(performance.now() - start),
          };
        }
      };
      await Promise.all([
        koraOne?.enabled
          ? run('koraOne', () => incidentClient.check())
          : Promise.resolve(),
        services.coreBackend
          ? run('coreBackend', async () => ({
              identityVerified: true,
              ...(await coreBackend.identity({ force: true })),
            }))
          : Promise.resolve(
              (report.coreBackend = { configured: false, ok: false }),
            ),
        services.coreAi
          ? run('coreAi', async () => {
              setting(services.coreAi, 'serviceKey', env);
              setting(services.coreAi, 'appId', env);
              setting(services.coreAi, 'appKey', env);
              const { data } = await jsonRequest(
                endpoint(services.coreAi, '/openapi.json', env),
                { fetchImpl: options.fetchImpl, timeoutMs: 10000 },
              );
              assert(
                data.paths?.['/v1/chat/completions']?.post,
                'Core AI does not expose /v1/chat/completions',
              );
              return {
                reachable: true,
                contractVerified: true,
                inferenceVerified: false,
              };
            })
          : Promise.resolve((report.coreAi = { configured: false, ok: false })),
        hai
          ? run('hai', async () => {
              if (hai.enabled)
                assert(
                  hai.contractVerified === true,
                  'HAI contract must be reviewed before enabling repair requests',
                );
              const headers = !hai.enabled
                ? {}
                : haiCredentials
                  ? await haiCredentials.headers()
                  : envHeaders(hai.headersEnv, env);
              const { data } = await jsonRequest(
                endpoint(haiConfig, '/openapi.json', env),
                { headers, fetchImpl: options.fetchImpl, timeoutMs: 10000 },
              );
              assert(
                data.paths?.['/v1/tasks']?.post &&
                  data.paths?.['/v1/runs/{run_id}']?.get,
                'HAI task/run service contract is unavailable',
              );
              return {
                reachable: true,
                taskContractVerified: true,
                clarificationContractVerified: Boolean(
                  data.paths?.['/v1/runs/{run_id}/clarify']?.post,
                ),
                repairEnabled: hai.enabled === true,
                repairVerified: false,
              };
            })
          : Promise.resolve((report.hai = { configured: false, ok: false })),
      ]);
      const required =
        services.required ?? (services.coreAi ? ['coreBackend', 'coreAi'] : []);
      return {
        mode: required.length ? 'services' : 'demo-or-custom',
        ready:
          required.every((name) => report[name]?.ok) &&
          (!koraOne?.enabled || report.koraOne?.ok === true),
        services: report,
      };
    },
  };
}
