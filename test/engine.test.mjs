/** Scheduler, outcome gating, tenant/actor context and durable ambiguous-request regressions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CampaignRun,
  DemoConversationAdapter,
  DemoModel,
  RunStore,
  validateCampaign,
  validateGeneratedCampaign,
} from '../src/index.mjs';
import { sleep } from '../src/util.mjs';

const role = (id) => ({
  id,
  name: id,
  description: `${id} fictional QA persona`,
});
const step = (id, actorId, rest = {}) => ({
  id,
  actorId,
  goal: `Complete ${id}`,
  maxTurns: 1,
  ...rest,
});
const campaign = (scenarios) => ({
  version: 1,
  name: 'Regression campaign',
  target: 'test',
  roles: [role('parent'), role('teacher'), role('child')],
  concurrency: 2,
  maxModelCalls: 100,
  scenarios,
});
const scenario = (id, steps) => ({ id, title: id, steps });
class TestModel extends DemoModel {
  kind = 'test';
  async complete(purpose, payload) {
    if (purpose === 'judge')
      return {
        verdict: 'pass',
        goalComplete: true,
        category: 'none',
        reason: 'Test oracle',
        evidence: [],
      };
    return super.complete(purpose, payload);
  }
}
function adapter(overrides = {}) {
  return {
    kind: 'test',
    config: {},
    send: async () => ({ text: 'Saved', status: 200 }),
    verify: async () => ({
      status: 'passed',
      checks: [{ label: 'Saved identity', passed: true }],
      evidence: { savedId: 'verified-123' },
    }),
    ...overrides,
  };
}
function runner(input, overrides = {}) {
  return new CampaignRun(input, {
    adapter: adapter(),
    actorModel: new TestModel(),
    ...overrides,
  });
}

test('rejects dependency cycles, unknown actors and invented model hooks', () => {
  assert.throws(
    () =>
      validateCampaign(
        campaign([
          scenario('cycle', [
            step('one', 'parent', { dependsOn: ['two'] }),
            step('two', 'teacher', { dependsOn: ['one'] }),
          ]),
        ]),
      ),
    /cycle/,
  );
  assert.throws(
    () =>
      validateCampaign(campaign([scenario('bad', [step('one', 'stranger')])])),
    /known actor/,
  );
  const input = campaign([
    scenario('hooks', [step('one', 'parent', { verifierId: 'invented' })]),
  ]);
  assert.throws(
    () =>
      validateGeneratedCampaign(input, { target: 'test', roles: input.roles }),
    /invented a verifier/,
  );
});

test('independent actors overlap, concurrency stays bounded and dependency uses verified artifacts', async () => {
  let active = 0,
    maximum = 0;
  const sent = [];
  const target = adapter({
    send: async (input) => {
      sent.push(input);
      active++;
      maximum = Math.max(maximum, active);
      await sleep(20);
      active--;
      return { text: 'Saved', status: 200 };
    },
  });
  const run = runner(
    campaign([
      scenario('lesson', [
        step('create', 'parent', {
          effect: 'write',
          verifierId: 'receipt',
          exports: { lessonId: 'savedId' },
        }),
        step('schedule', 'teacher', {
          dependsOn: ['create'],
          effect: 'write',
          verifierId: 'receipt',
        }),
      ]),
      scenario('other', [step('read', 'child', { verifierId: 'receipt' })]),
    ]),
    { adapter: target },
  );
  const result = await run.start();
  assert.equal(result.status, 'completed');
  assert.equal(maximum, 2);
  assert.equal(
    sent.find((input) => input.step.id === 'schedule').shared.create.lessonId,
    'verified-123',
  );
  assert.deepEqual(sent.find((input) => input.step.id === 'read').shared, {});
  assert.equal(result.qualified, true);
});

test('failed API receipt blocks a dependency even when the judge says pass', async () => {
  const sent = [];
  const run = runner(
    campaign([
      scenario('lesson', [
        step('create', 'parent', { verifierId: 'receipt' }),
        step('schedule', 'teacher', { dependsOn: ['create'] }),
      ]),
    ]),
    {
      adapter: adapter({
        send: async (input) => {
          sent.push(input.step.id);
          return { text: 'Done', status: 200 };
        },
        verify: async () => ({
          status: 'failed',
          checks: [{ label: 'Actual child', passed: false }],
        }),
      }),
    },
  );
  const result = await run.start();
  assert.deepEqual(sent, ['create']);
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[1].status, 'blocked');
  assert.equal(result.qualified, false);
});

test('a write cannot be sent without an independent verifier', async () => {
  let calls = 0;
  const run = runner(
    campaign([
      scenario('write', [step('create', 'parent', { effect: 'write' })]),
    ]),
    {
      adapter: adapter({
        send: async () => {
          calls++;
        },
      }),
    },
  );
  const result = await run.start();
  assert.equal(calls, 0);
  assert.equal(result.steps[0].status, 'failed');
});

test('a campaign object cannot be started twice and model budget exhaustion cannot pass', async () => {
  const run = runner(campaign([scenario('once', [step('one', 'parent')])]));
  await run.start();
  await assert.rejects(run.start(), /only start once/);
  const bounded = campaign([scenario('budget', [step('one', 'parent')])]);
  bounded.maxModelCalls = 1;
  const result = await runner(bounded).start();
  assert.equal(result.status, 'failed');
  assert.equal(result.qualified, false);
  assert.equal(result.steps[0].transcript.length, 0);
});

test('same actor/world is serialized and separate scenarios retain separate conversations', async () => {
  let active = 0,
    maximum = 0;
  const messages = [];
  const target = adapter({
    send: async (input) => {
      active++;
      maximum = Math.max(active, maximum);
      messages.push(input);
      await sleep(10);
      active--;
      return { text: 'Done', status: 200 };
    },
  });
  const input = campaign([
    scenario('one', [
      step('first', 'parent'),
      step('second', 'parent', { dependsOn: ['first'] }),
    ]),
    { ...scenario('two', [step('third', 'parent')]), worldId: 'one' },
  ]);
  const result = await runner(input, { adapter: target }).start();
  assert.equal(maximum, 1);
  assert.equal(messages[0].conversationId, messages[1].conversationId);
  assert.notEqual(messages[0].conversationId, messages[2].conversationId);
  assert.equal(messages[2].history.length, 0);
  assert.equal(result.status, 'completed');
});

test('an ambiguous send is persisted once and never retried or reported as passed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-unknown-'));
  const store = new RunStore(directory);
  let calls = 0;
  const target = adapter({
    send: async () => {
      calls++;
      throw new Error('Connection lost');
    },
  });
  const result = await runner(
    campaign([scenario('ambiguous', [step('send', 'parent')])]),
    { store, adapter: target },
  ).start();
  assert.equal(calls, 1);
  assert.equal(result.steps[0].status, 'outcome_unknown');
  assert.equal(store.read(result.id).steps[0].inFlight, true);
  assert.equal(result.qualified, false);
});

test('restart quarantines in-flight requests and preserves accepted HAI IDs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-restart-'));
  const store = new RunStore(directory);
  store.save({
    id: 'restart-test',
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: [
      {
        status: 'running',
        inFlight: true,
        pendingMessageId: 'original',
        repair: { status: 'polling', providerRunId: 'provider-1', attempts: 1 },
      },
    ],
  });
  store.recoverInterrupted();
  const result = store.read('restart-test');
  assert.equal(result.status, 'interrupted');
  assert.equal(result.steps[0].status, 'outcome_unknown');
  assert.equal(result.steps[0].repair.providerRunId, 'provider-1');
  assert.equal(result.steps[0].repair.status, 'poll_interrupted');
});

test('insufficient goal completion and observer unavailability are unverified', async () => {
  const model = new TestModel();
  const original = model.complete.bind(model);
  model.complete = (purpose, payload) =>
    purpose === 'judge'
      ? {
          verdict: 'pass',
          goalComplete: false,
          reason: 'Still clarifying',
          category: 'none',
        }
      : original(purpose, payload);
  const result = await runner(
    campaign([scenario('incomplete', [step('clarify', 'parent')])]),
    { actorModel: model },
  ).start();
  assert.equal(result.steps[0].status, 'unverified');
  assert.equal(result.qualified, false);
  const unavailable = await runner(
    campaign([
      scenario('unavailable', [
        step('check', 'parent', { verifierId: 'receipt' }),
      ]),
    ]),
    {
      adapter: adapter({
        verify: async () => {
          throw new Error('Observer down');
        },
      }),
    },
  ).start();
  assert.equal(unavailable.steps[0].status, 'unverified');
});

test('pause prevents new target turns until resumed; stop quarantines an in-flight send', async () => {
  let release;
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const run = runner(
    campaign([
      scenario('paused', [
        step('one', 'parent'),
        step('two', 'teacher', { dependsOn: ['one'] }),
      ]),
    ]),
    {
      adapter: adapter({
        send: async () => {
          started();
          await blocked;
          return { text: 'Done', status: 200 };
        },
      }),
    },
  );
  const completion = run.start();
  await entered;
  run.pause();
  release();
  await sleep(30);
  assert.equal(run.state.steps[1].status, 'pending');
  run.resume();
  await completion;
  assert.equal(run.state.status, 'completed');
  let enteredStop;
  const startedStop = new Promise((resolve) => {
    enteredStop = resolve;
  });
  const stopped = runner(
    campaign([scenario('stopping', [step('one', 'parent')])]),
    {
      adapter: adapter({
        send: async (_, { signal }) => {
          enteredStop();
          await sleep(10000, signal);
        },
      }),
    },
  );
  const stopCompletion = stopped.start();
  await startedStop;
  stopped.stop();
  const result = await stopCompletion;
  assert.equal(result.status, 'stopped');
  assert.equal(result.steps[0].status, 'outcome_unknown');
});

test('secrets are removed from model prompts, dashboard state and persisted evidence', async () => {
  const secret = 'private-test-credential-123456';
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-redact-'));
  const store = new RunStore(directory, { secrets: [secret] });
  const seen = [];
  const model = new TestModel();
  const complete = model.complete.bind(model);
  model.complete = (purpose, payload) => {
    seen.push(payload);
    return complete(purpose, payload);
  };
  const result = await runner(
    campaign([scenario('redact', [step('one', 'parent')])]),
    {
      secrets: [secret],
      store,
      actorModel: model,
      adapter: adapter({
        send: async () => ({ text: `oops ${secret}`, status: 200 }),
      }),
    },
  ).start();
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(seen).includes(secret));
  assert.ok(
    !readFileSync(store.path(result.id, 'json'), 'utf8').includes(secret),
  );
});

test('demo lifecycle is parallel and visibly simulated, with a seeded failed/blocked branch', async () => {
  const example = JSON.parse(
    readFileSync(
      new URL('../examples/lesson-lifecycle.json', import.meta.url),
      'utf8',
    ),
  );
  const result = await new CampaignRun(example, {
    adapter: new DemoConversationAdapter({ delayMs: 1 }),
    actorModel: new DemoModel(),
  }).start();
  assert.equal(
    result.steps.filter((step) => step.status === 'simulated').length,
    6,
  );
  assert.equal(
    result.steps.filter((step) => step.status === 'failed').length,
    1,
  );
  assert.equal(
    result.steps.filter((step) => step.status === 'blocked').length,
    1,
  );
  assert.equal(result.qualified, false);
  assert.equal(result.demo, true);
  assert.match(
    result.steps.find((step) => step.id === 'readSummary').response.text,
    /practise longer words/,
  );
});

test('progress snapshots expose pending product reply before any invented assistant turn and then verification and judging', async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };
  const product = deferred();
  const observer = deferred();
  const evaluator = deferred();
  const sent = deferred();
  const verifying = deferred();
  const judging = deferred();
  const actorModel = new TestModel();
  const run = runner(
    campaign([
      scenario('progress', [step('ask', 'parent', { verifierId: 'receipt' })]),
    ]),
    {
      adapter: adapter({
        send: async () => {
          sent.resolve();
          return product.promise;
        },
        verify: async () => {
          verifying.resolve();
          return observer.promise;
        },
      }),
      actorModel,
      judgeModel: {
        complete: async () => {
          judging.resolve();
          return evaluator.promise;
        },
      },
    },
  );
  const completion = run.start();
  await sent.promise;
  const pending = run.snapshot().steps[0];
  assert.equal(pending.activity.phase, 'waiting_reply');
  assert.equal(pending.inFlight, true);
  assert.equal(pending.transcript.length, 1);
  assert.equal(pending.transcript[0].role, 'user');
  assert.ok(pending.pendingMessageId);
  product.resolve({ text: 'Actual delayed reply', status: 200 });
  await verifying.promise;
  assert.equal(run.snapshot().steps[0].activity.phase, 'verifying');
  assert.equal(
    run.snapshot().steps[0].transcript[1].text,
    'Actual delayed reply',
  );
  observer.resolve({ status: 'passed', checks: [], evidence: {} });
  await judging.promise;
  assert.equal(run.snapshot().steps[0].activity.phase, 'evaluating');
  evaluator.resolve({
    verdict: 'pass',
    goalComplete: true,
    category: 'none',
    reason: 'Checked',
    evidence: [],
  });
  const result = await completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.steps[0].activity.phase, 'finished');
  assert.ok(result.events.some((event) => event.phase === 'composing'));
});

test('generated live plans use only configured QA worlds and actor bindings', () => {
  const input = campaign([scenario('known', [step('read', 'parent')])]);
  const options = {
    target: input.target,
    roles: input.roles,
    worlds: [{ id: 'known', actorIds: ['parent'] }],
  };
  assert.equal(
    validateGeneratedCampaign(input, options).scenarios[0].worldId,
    'known',
  );
  assert.throws(
    () =>
      validateGeneratedCampaign(input, {
        ...options,
        worlds: [{ id: 'different', actorIds: ['parent'] }],
      }),
    /unbound actor/,
  );
  assert.throws(
    () =>
      validateGeneratedCampaign(input, {
        ...options,
        worlds: [{ id: 'known', actorIds: ['teacher'] }],
      }),
    /unbound actor/,
  );
});
