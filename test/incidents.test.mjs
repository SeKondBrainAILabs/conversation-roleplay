import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KoraOneIncidentClient,
  capabilityIncident,
  incidentEligible,
  validateIncidentContract,
  CampaignRun,
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
  checkpoint: async () => {},
});
const identity = { orgId: 'canonical-org', userId: 'service-user' };
const config = {
  enabled: true,
  contractVerified: true,
  baseUrl: 'https://kora.example',
  probeProduct: 'piggybank',
};
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const incident = (body) => ({
  ...body,
  org_id: identity.orgId,
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
  assert.throws(
    () => capabilityIncident({ ...input(), platformRole: 'parent' }),
    /authenticated platform/,
  );
  assert.throws(
    () => validateIncidentContract({ ...contract, orgId: 'spoof' }),
    /authority/,
  );
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
    assert.equal(new URL(url).searchParams.get('status'), 'all');
    return response({ incidents: [incident(capabilityIncident(value).body)] });
  });
  assert.equal((await recovered.report(value)).status, 'submission_unknown');
  const correlated = await recovered.reconcile(value, unknown);
  assert.equal(correlated.status, 'incident_recorded');
  assert.equal(correlated.effectVerified, false);
  assert.deepEqual(reconciledCheckpoints, [correlated]);
  assert.equal(posts, 1);
});
test('a receipt for a different skill, API or evidence summary cannot release quarantine', async () => {
  for (const mismatch of [
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
        auth: { bearerEnv: 'ONE_TOKEN' },
      },
    },
  };
  let denied = false;
  const stack = createServiceStack(cfg, {
    env: {
      CORE_TOKEN: 'core-private',
      ONE_TOKEN: 'one-private',
      ONE_URL: 'https://kora.example',
    },
    fetchImpl: async (url, options) => {
      if (new URL(url).hostname === 'core.example')
        return response({
          org_id: '11111111-1111-4111-8111-111111111111',
          user_id: '22222222-2222-4222-8222-222222222222',
        });
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
  assert.equal(
    (await other.reconcile(value, receipt)).status,
    'submission_unknown',
  );
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
      fetchImpl: async () => {
        throw Error('Must not call');
      },
    },
  );
  await assert.rejects(c.report(input()), /Foreign organization/);
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
