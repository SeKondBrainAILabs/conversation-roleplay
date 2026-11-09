import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KoraOneIncidentClient,
  capabilityIncident,
  incidentEligible,
  validateIncidentContract,
  CampaignRun,
  createLab,
} from '../src/index.mjs';
import { createServiceStack } from '../src/services.mjs';
const contract = {
  product: 'piggybank',
  platformRole: 'child',
  roleIds: ['family.child'],
  incidentType: 'eval_failed',
  reasonCode: 'task_details_omitted',
  caseId: 'piggybank.tasks.read_details',
};
const step = () => ({
  id: 'details',
  status: 'failed',
  goal: 'Read task details',
  effect: 'read',
  maxTurns: 1,
  verifierId: 'tasks',
  incidentContractId: 'taskDetails',
  transcript: [
    { role: 'user', text: 'PRIVATE household name and private question' },
  ],
  judgment: {
    verdict: 'fail',
    goalComplete: false,
    category: 'missing_capability',
    reason: 'PRIVATE narrative',
  },
  verification: {
    status: 'passed',
    evidence: { familyId: 'PRIVATE family', balance: 42 },
    checks: [{ passed: true }],
  },
});
const input = () => ({
  contract,
  step: step(),
  product: 'piggybank',
  platformRole: 'child',
  runId: 'private-run-id',
  scenarioId: 'private-scenario',
  sourceRevision: 'd'.repeat(40),
  checkpoint: async () => {},
});
const identity = { orgId: 'canonical-org', userId: 'service-user' };
const config = {
  enabled: true,
  contractVerified: true,
  reporterClientId: 'conversation-roleplay-feet',
  baseUrl: 'https://kora.example',
  probeProduct: 'piggybank',
  sourceRevision: 'd'.repeat(40),
};
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const incident = (body) => ({
  ...body,
  org_id: identity.orgId,
  reporter_client_id: config.reporterClientId,
  incident_id: 'capinc_' + 'a'.repeat(32),
  case_id: body.case_id ?? null,
  skill_id: body.skill_id ?? null,
  api_id: body.api_id ?? null,
  registry_version: '1.0.0',
  registry_digest: 'c'.repeat(64),
  hai_delivery_status: 'published',
});
const client = (fetchImpl) =>
  new KoraOneIncidentClient(
    config,
    { identity: async () => identity },
    {
      fetchImpl,
      getHeaders: async () => ({
        Authorization: 'Bearer private-service-credential',
      }),
      getClientId: () => 'conversation-roleplay-feet',
    },
  );
test('the incident payload contains configured graph references and typed diagnostics, never private conversation or observer facts', () => {
  const value = capabilityIncident(input());
  const serialized = JSON.stringify(value.body);
  assert.ok(!serialized.includes('PRIVATE'));
  assert.ok(!serialized.includes('private-run-id'));
  assert.equal(value.body.source_product, 'piggybank');
  assert.equal(value.body.case_id, contract.caseId);
  assert.equal(value.fingerprint.length, 64);
  assert.equal(value.body.safe_context.adapter, 'conversation-roleplay');
  assert.equal(value.body.safe_context.evaluation_verdict, 'fail');
  assert.equal(value.body.safe_context.effect_verified, false);
  assert.equal(value.body.safe_context.evidence_digest.length, 64);
  assert.throws(
    () => capabilityIncident({ ...input(), platformRole: 'parent' }),
    /authenticated platform/,
  );
  assert.throws(
    () => validateIncidentContract({ ...contract, orgId: 'spoof' }),
    /authority/,
  );
});
test('the submitted trace satisfies the pinned Kora One HTTP contract', async () => {
  const peer = JSON.parse(
    readFileSync(new URL('./fixtures/kora-one-trace-contract.json', import.meta.url)),
  ).traceIdentifier;
  const pattern = new RegExp(peer.pattern);
  const value = input();
  const c = client(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.trace_id.length >= peer.min_length);
    assert.ok(body.trace_id.length <= peer.max_length);
    assert.match(body.trace_id, pattern);
    assert.equal(body.safe_context.eval_id, body.trace_id);
    // The old identifier was accepted by mocks but rejected by the real API.
    assert.equal(pattern.test(`roleplay.${capabilityIncident(value).fingerprint}`), false);
    return response({ created: true, incident: incident(body) }, 202);
  });
  assert.equal((await c.report(value)).status, 'incident_recorded');
});
test('correct permission denials, evaluator errors, invalid actor requests and unknown outcomes do not become product repairs', async () => {
  for (const bad of [
    { status: 'outcome_unknown' },
    { errorSource: 'evaluator' },
    { error: 'Judge contract invalid' },
    { judgment: { verdict: 'fail', category: 'policy_denial' } },
    { instructionResults: [{ status: 'invalid_request' }] },
  ]) {
    const value = { ...step(), ...bad };
    assert.equal(incidentEligible(value), false);
    const c = client(() => {
      throw Error('No network allowed');
    });
    assert.equal(
      (await c.report({ ...input(), step: value })).status,
      'not_eligible',
    );
  }
});
test('an independent failed API assertion is reported even when the LLM passes the reply', () => {
  const value = input();
  value.step.judgment = {
    verdict: 'pass',
    category: 'none',
    goalComplete: true,
  };
  value.step.verification = {
    status: 'failed',
    checks: [{ instructionId: 'deadline', passed: false }],
  };
  assert.equal(incidentEligible(value.step), true);
  const payload = capabilityIncident(value).body;
  assert.equal(payload.safe_context.error_class, 'effect_mismatch');
  assert.equal(payload.safe_context.evaluation_source, 'api_readback');
  assert.equal(payload.safe_context.failed_check_count, 1);
});
test('one incident POST uses canonical identity and idempotency, preserves the failed result and never claims a healed effect', async () => {
  let calls = 0;
  const checkpoints = [];
  const value = input();
  value.checkpoint = async (r) => checkpoints.push(r);
  const c = client(async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/api/internal/capabilities/incidents');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Organization-Id'], identity.orgId);
    const body = JSON.parse(options.body);
    assert.equal(
      options.headers['Idempotency-Key'],
      capabilityIncident(value).fingerprint,
    );
    assert.ok(!options.body.includes('PRIVATE'));
    return response({ created: true, incident: incident(body) }, 202);
  });
  const [a, b] = await Promise.all([c.report(value), c.report(value)]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(a.status, 'incident_recorded');
  assert.equal(a.effectVerified, false);
  assert.equal(value.step.status, 'failed');
  assert.deepEqual(
    checkpoints.map((r) => r.status),
    ['submitting', 'incident_recorded'],
  );
});
test('an uncertain submission is never repeated, including by a new client after restart; GET readback can correlate it', async () => {
  const value = input();
  let posts = 0;
  const c = client(async () => {
    posts++;
    throw Error('connection lost');
  });
  const unknown = await c.report(value);
  assert.equal(unknown.status, 'submission_unknown');
  await c.report(value);
  assert.equal(posts, 1);
  value.step.incident = unknown;
  const reconciledCheckpoints = [];
  value.checkpoint = async (r) => reconciledCheckpoints.push(r);
  const recovered = client(async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(
      new URL(url).pathname,
      `/api/internal/capabilities/incidents/receipts/${capabilityIncident(value).body.trace_id}`,
    );
    assert.equal(new URL(url).search, '');
    return response({ incident: incident(capabilityIncident(value).body) });
  });
  assert.equal((await recovered.report(value)).status, 'submission_unknown');
  const correlated = await recovered.reconcile(value, unknown);
  assert.equal(correlated.status, 'incident_recorded');
  assert.equal(correlated.effectVerified, false);
  assert.deepEqual(reconciledCheckpoints, [correlated]);
  assert.equal(posts, 1);
});
test('dashboard startup reconciles an uncertain incident by exact receipt GET without replaying its POST', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-reconcile-'));
  const orgId = '64f0a200-e26e-4dd0-87a2-3d7db75fc429';
  const userId = '74f0a200-e26e-4dd0-87a2-3d7db75fc430';
  const savedStep = {
    ...step(),
    worldId: 'world',
    actorId: 'child',
    scenarioId: 'story',
  };
  const prepared = capabilityIncident({
    contract,
    step: savedStep,
    product: 'piggybank',
    platformRole: 'child',
    runId: 'saved-run',
    scenarioId: 'story',
    sourceRevision: 'd'.repeat(40),
  });
  savedStep.incident = {
    status: 'submission_unknown',
    fingerprint: prepared.fingerprint,
    sourceRevision: 'd'.repeat(40),
    effectVerified: false,
  };
  writeFileSync(
    join(directory, 'saved-run.json'),
    JSON.stringify({
      id: 'saved-run',
      name: 'Saved run',
      target: 'piggybank',
      status: 'interrupted',
      startedAt: new Date().toISOString(),
      campaign: { version: 1 },
      steps: [savedStep],
    }),
  );
  const methods = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'core.example')
      return response({ org_id: orgId, user_id: userId });
    if (parsed.hostname === 'id.example')
      return response({ access_token: 'kora-service-token', expires_in: 300 });
    methods.push(options.method ?? 'GET');
    assert.equal(parsed.hostname, 'kora.example');
    assert.equal(
      parsed.pathname,
      `/api/internal/capabilities/incidents/receipts/${prepared.body.trace_id}`,
    );
    return response({
      incident: {
        ...incident(prepared.body),
        org_id: orgId,
      },
    });
  };
  const lab = createLab(
    {
      services: {
        coreBackend: {
          baseUrl: 'https://core.example',
          auth: { bearerEnv: 'CORE_BEARER' },
        },
        koraOne: {
          ...config,
          baseUrl: 'https://kora.example',
          auth: {
            oauth: {
              tokenUrl: 'https://id.example/token',
              clientIdEnv: 'KORA_CLIENT_ID',
              clientSecretEnv: 'KORA_CLIENT_SECRET',
            },
          },
        },
      },
      targets: {
        piggybank: {
          type: 'http',
          baseUrl: 'https://product.example',
          qaOnly: true,
          bindings: {
            world: { child: { qa: true, context: { role: 'child' } } },
          },
          incidentContracts: { taskDetails: contract },
        },
      },
    },
    {
      directory,
      env: {
        CORE_BEARER: 'core-service-token',
        KORA_CLIENT_ID: 'conversation-roleplay-feet',
        KORA_CLIENT_SECRET: 'kora-service-secret',
        ROLEPLAY_REVISION: 'd'.repeat(40),
      },
      fetchImpl,
    },
  );

  const reconciled = await lab.incidentReconciliation;
  const restored = lab.store.read('saved-run');
  lab.dispose();

  assert.equal(
    reconciled[0]?.status,
    'incident_recorded',
    JSON.stringify(reconciled),
  );
  assert.deepEqual(methods, ['GET']);
  assert.equal(restored.steps[0].incident.status, 'incident_recorded');
  assert.equal(restored.steps[0].incident.effectVerified, false);
});
test('a receipt for a different skill, API or evidence summary cannot release quarantine', async () => {
  for (const mismatch of [
    { reporter_client_id: 'foreign-reporter' },
    { skill_id: 'foreign.skill' },
    { api_id: 'foreign.api' },
    { safe_context: { producer: 'other' } },
  ]) {
    const value = input();
    const c = client(async () =>
      response(
        {
          incident: {
            ...incident(capabilityIncident(value).body),
            ...mismatch,
          },
        },
        202,
      ),
    );
    assert.equal((await c.report(value)).status, 'submission_unknown');
  }
});
test('service readiness checks the real catalog and refuses missing canonical Kora One access', async () => {
  const cfg = {
    services: {
      required: ['coreBackend'],
      coreBackend: {
        baseUrl: 'https://core.example',
        auth: { bearerEnv: 'CORE_TOKEN' },
      },
      koraOne: {
        ...config,
        baseUrlEnv: 'ONE_URL',
        auth: {
          oauth: {
            tokenUrl: 'https://id.example/token',
            clientIdEnv: 'ONE_CLIENT_ID',
            clientSecretEnv: 'ONE_CLIENT_SECRET',
          },
        },
      },
    },
  };
  let denied = false;
  const stack = createServiceStack(cfg, {
    env: {
      CORE_TOKEN: 'core-private',
      ONE_CLIENT_ID: 'conversation-roleplay-feet',
      ONE_CLIENT_SECRET: 'one-private',
      ONE_URL: 'https://kora.example',
    },
    fetchImpl: async (url, options) => {
      if (new URL(url).hostname === 'core.example')
        return response({
          org_id: '11111111-1111-4111-8111-111111111111',
          user_id: '22222222-2222-4222-8222-222222222222',
        });
      if (new URL(url).hostname === 'id.example')
        return response({ access_token: 'one-private', expires_in: 300 });
      assert.equal(new URL(url).pathname, '/api/internal/capabilities/catalog');
      assert.equal(options.headers.Authorization, 'Bearer one-private');
      assert.equal(
        options.headers['X-Organization-Id'],
        '11111111-1111-4111-8111-111111111111',
      );
      if (denied) return response({}, 403);
      return response({
        product: 'piggybank',
        version: '1.0.0',
        digest: 'c'.repeat(64),
        cases: [],
        roles: [],
      });
    },
  });
  assert.equal((await stack.check()).ready, true);
  denied = true;
  const result = await stack.check();
  assert.equal(result.ready, false);
  assert.equal(result.services.koraOne.ok, false);
});
test('a foreign receipt stays quarantined and an unavailable readback never authorizes another POST', async () => {
  const value = input();
  const c = client(async () =>
    response(
      {
        incident: {
          ...incident(capabilityIncident(value).body),
          org_id: 'foreign',
        },
      },
      202,
    ),
  );
  const receipt = await c.report(value);
  assert.equal(receipt.status, 'submission_unknown');
  const other = client(async () => response({ incidents: [] }));
  const missing = await other.reconcile(value, receipt);
  assert.equal(missing.status, 'submission_unknown');
  assert.equal(missing.reconciliationError, 'receipt_not_found');
  const denied = await client(async () => response({}, 403)).reconcile(
    value,
    receipt,
  );
  assert.equal(denied.reconciliationError, 'http_403');
});
test('a rejected incident is retained across restart without an unchanged POST retry', async () => {
  const value = input();
  const c = client(async () => response({}, 403));
  value.step.incident = await c.report(value);
  assert.equal(value.step.incident.status, 'submission_rejected');
  const restarted = client(async () => {
    throw Error('No retry allowed');
  });
  assert.deepEqual(await restarted.report(value), value.step.incident);
});
test('canonical identity failure stops before any control-plane POST', async () => {
  const c = new KoraOneIncidentClient(
    config,
    {
      identity: async () => {
        throw Error('Foreign organization');
      },
    },
    {
      getHeaders: async () => ({}),
      getClientId: () => 'conversation-roleplay-feet',
      fetchImpl: async () => {
        throw Error('Must not call');
      },
    },
  );
  await assert.rejects(c.report(input()), /Foreign organization/);
});
test('a different OAuth client is rejected before any Kora One request', async () => {
  let called = false;
  const c = new KoraOneIncidentClient(
    config,
    { identity: async () => identity },
    {
      getHeaders: async () => ({ Authorization: 'Bearer wrong-client' }),
      getClientId: () => 'basanti-service',
      fetchImpl: async () => {
        called = true;
        throw Error('Must not call');
      },
    },
  );

  await assert.rejects(c.report(input()), /dedicated conversation-roleplay-feet/);
  assert.equal(called, false);
});
test('an engine failure records an HAI incident without replay, hidden direct repair or promotion', async () => {
  let targetCalls = 0,
    reported = 0;
  const campaign = {
    version: 1,
    name: 'HAI incident test',
    target: 'piggybank',
    roles: [{ id: 'child', name: 'Child', description: 'Child' }],
    scenarios: [
      {
        id: 'story',
        title: 'Same-person story',
        steps: [
          {
            id: 'details',
            actorId: 'child',
            goal: 'Read my task details',
            effect: 'read',
            maxTurns: 1,
            incidentContractId: 'taskDetails',
          },
        ],
      },
    ],
  };
  const run = new CampaignRun(campaign, {
    adapter: {
      kind: 'piggybank',
      config: { incidentContracts: { taskDetails: contract } },
      binding: () => ({ context: { role: 'child' } }),
      send: async () => {
        targetCalls++;
        return { text: 'Task name only', status: 200 };
      },
    },
    actorModel: {
      kind: 'llm',
      complete: async (p) =>
        p === 'enhance'
          ? { roles: campaign.roles.map((r) => ({ ...r, persona: {} })) }
          : { message: 'Which task and when?', done: false },
    },
    judgeModel: { kind: 'llm', complete: async () => step().judgment },
    incidentClient: {
      config,
      report: async (i) => {
        reported++;
        const r = {
          status: 'incident_recorded',
          effectVerified: false,
          incidentId: 'test',
        };
        await i.checkpoint(r);
        return r;
      },
    },
  });
  const result = await run.start();
  assert.equal(targetCalls, 1);
  assert.equal(reported, 1);
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[0].incident.effectVerified, false);
  assert.equal(result.qualified, false);
});
test('HAI-led campaign preflight stops before target traffic when the registry connection is disabled', () => {
  const campaign = {
    version: 1,
    name: 'Preflight',
    target: 'piggybank',
    roles: [{ id: 'child', name: 'Child', description: 'Child' }],
    scenarios: [
      {
        id: 'story',
        title: 'Same-person story',
        steps: [
          {
            id: 'details',
            actorId: 'child',
            goal: 'Read',
            incidentContractId: 'taskDetails',
          },
        ],
      },
    ],
  };
  assert.throws(
    () =>
      new CampaignRun(campaign, {
        adapter: {
          kind: 'piggybank',
          config: { incidentContracts: { taskDetails: contract } },
          binding: () => ({ context: { role: 'child' } }),
        },
        actorModel: { kind: 'llm' },
        incidentClient: { config: { enabled: false } },
      }),
    /incident service enabled/,
  );
});
