import test from 'node:test';
import assert from 'node:assert/strict';
import { instructionResults } from '../src/instructions.mjs';
import {
  CampaignRun,
  HttpConversationAdapter,
  validateCampaign,
} from '../src/index.mjs';

const instructions = [
  { id: 'first', text: 'Create Milo task', effect: 'write' },
  { id: 'second', text: 'Create Nora task', effect: 'write' },
];
const step = {
  id: 'compound',
  actorId: 'parent',
  goal: 'Create both tasks',
  effect: 'write',
  verifierId: 'both',
  instructions,
  maxTurns: 1,
};
const campaign = (value = step) => ({
  version: 1,
  name: 'Compound test',
  target: 'qa',
  roles: [{ id: 'parent', name: 'Maya', description: 'Parent' }],
  scenarios: [{ id: 'qa', title: 'QA', steps: [value] }],
});
const judgment = () => ({
  verdict: 'pass',
  goalComplete: true,
  category: 'none',
  reason: 'Overall opinion',
  instructions: instructions.map((item) => ({
    id: item.id,
    requestIncluded: true,
    verdict: 'pass',
    goalComplete: true,
    reason: 'Checked individually',
  })),
});
const verified = () => ({
  status: 'passed',
  evidence: {},
  checks: instructions.map((item) => ({
    instructionId: item.id,
    label: item.id,
    passed: true,
  })),
});

test('partial compound success cannot be promoted by an overall pass', () => {
  const judge = judgment();
  judge.instructions[1].verdict = 'fail';
  judge.instructions[1].goalComplete = false;
  const results = instructionResults(step, judge, verified());
  assert.deepEqual(
    results.map((x) => x.status),
    ['passed', 'failed'],
  );
});
test('missing duplicate and unknown instruction verdicts are rejected', () => {
  for (const ids of [['first'], ['first', 'first'], ['first', 'foreign']]) {
    const judge = judgment();
    judge.instructions = ids.map((id) => ({ ...judge.instructions[0], id }));
    assert.throws(
      () => instructionResults(step, judge, verified()),
      /every instruction|duplicate or unknown/,
    );
  }
});
test('API contradiction overrides a semantic pass and missing write proof stays unverified', () => {
  const api = verified();
  api.checks[1].passed = false;
  assert.equal(instructionResults(step, judgment(), api)[1].status, 'failed');
  api.checks = [];
  assert.equal(
    instructionResults(step, judgment(), api)[0].status,
    'unverified',
  );
});
test('an instruction never asked by the actor is an invalid test request', () => {
  const judge = judgment();
  judge.instructions[1].requestIncluded = false;
  assert.equal(
    instructionResults(step, judge, verified())[1].status,
    'invalid_request',
  );
});
test('compound schema rejects disguised writes and duplicate instructions', () => {
  assert.throws(
    () => validateCampaign(campaign({ ...step, effect: 'read' })),
    /write step/,
  );
  assert.throws(
    () =>
      validateCampaign(
        campaign({ ...step, instructions: [instructions[0], instructions[0]] }),
      ),
    /unique IDs/,
  );
});
test('live engine records partial instruction failure and does not send blind follow-up writes', async () => {
  let sends = 0;
  const judge = judgment();
  judge.instructions[1].verdict = 'fail';
  judge.instructions[1].goalComplete = false;
  const run = new CampaignRun(campaign(), {
    actorModel: {
      kind: 'llm',
      complete: async (purpose) =>
        purpose === 'enhance'
          ? {
              roles: campaign().roles.map((r) => ({
                ...r,
                persona: { style: 'plain' },
              })),
            }
          : {
              message: 'Create a task for Milo and a task for Nora.',
              done: false,
              instructionIds: ['first', 'second'],
            },
    },
    judgeModel: { kind: 'llm', complete: async () => judge },
    adapter: {
      kind: 'http',
      config: {},
      send: async () => {
        sends++;
        return { text: 'Milo saved only', status: 200 };
      },
      verify: async () => verified(),
    },
  });
  const result = await run.start();
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.qualified, false);
  assert.equal(sends, 1);
  assert.equal(result.steps[0].judgment.verdict, 'pass');
  assert.equal(
    result.steps[0].transcript[1].instructionResults[1].status,
    'failed',
  );
});
test('actor omission is stopped before any target request', async () => {
  let sends = 0;
  const run = new CampaignRun(campaign(), {
    actorModel: {
      kind: 'llm',
      complete: async (purpose) =>
        purpose === 'enhance'
          ? { roles: campaign().roles.map((r) => ({ ...r, persona: {} })) }
          : {
              message: 'Create Milo task',
              done: false,
              instructionIds: ['first'],
            },
    },
    adapter: {
      kind: 'http',
      config: {},
      send: async () => {
        sends++;
      },
    },
  });
  const result = await run.start();
  assert.equal(sends, 0);
  assert.match(result.steps[0].error, /Actor did not include/);
});

const context = { id: 'qa-parent', familyId: 'qa-family', role: 'parent' };
const adapterConfig = {
  type: 'http',
  baseUrl: 'http://product.invalid',
  qaOnly: true,
  identity: {
    path: '/me',
    assertions: [{ path: 'id', op: 'eq', expected: '$actor.id' }],
  },
  bindings: { qa: { parent: { qa: true, context } } },
  verifiers: {
    both: {
      reads: { milo: { path: '/tasks/milo' }, nora: { path: '/tasks/nora' } },
      assertions: [
        {
          instructionId: 'first',
          path: 'milo.tasks',
          op: 'matches',
          expected: { name: 'Read', childId: 'milo' },
          count: 1,
        },
        {
          instructionId: 'second',
          path: 'nora.tasks',
          op: 'matches',
          expected: { name: 'Maths', childId: 'nora' },
          count: 1,
        },
      ],
    },
  },
};
const input = { worldId: 'qa', actor: { id: 'parent' }, step, shared: {} };
test('composite observers read independent APIs and detect duplicate or wrong-child records', async () => {
  const calls = [];
  const adapter = new HttpConversationAdapter(structuredClone(adapterConfig), {
    fetchImpl: async (url, options) => {
      calls.push(options.method);
      const path = new URL(url).pathname;
      return new Response(
        JSON.stringify(
          path === '/me'
            ? context
            : path.endsWith('milo')
              ? { tasks: [{ id: 'one', name: 'Read', childId: 'milo' }] }
              : {
                  tasks: [
                    { id: 'two', name: 'Maths', childId: 'nora' },
                    { id: 'duplicate', name: 'Maths', childId: 'nora' },
                  ],
                },
        ),
      );
    },
  });
  const receipt = await adapter.verify(input);
  assert.equal(receipt.status, 'failed');
  assert.deepEqual(
    receipt.checks.map((c) => c.passed),
    [true, false],
  );
  assert.deepEqual(calls, ['GET', 'GET', 'GET']);
  assert.ok(receipt.evidence.nora.tasks.length === 2);
});
test('write instructions and composite sources are checked before chat submission', () => {
  const config = structuredClone(adapterConfig);
  config.verifiers.both.assertions.pop();
  const adapter = new HttpConversationAdapter(config);
  assert.throws(() => adapter.assertStep(input), /Each write instruction/);
  config.verifiers.both.reads.milo.method = 'POST';
  assert.throws(() => adapter.assertStep(input), /GET-only/);
});

test('read-only correction preserves failed reply in the same conversation without erasing its failure', async () => {
  const first = {
    id: 'initial',
    actorId: 'parent',
    goal: 'Ask a question',
    maxTurns: 1,
    effect: 'read',
  };
  const second = {
    id: 'clarify',
    actorId: 'parent',
    goal: 'Clarify the earlier reply',
    after: ['initial'],
    maxTurns: 1,
    effect: 'read',
  };
  const config = campaign(first);
  config.scenarios[0].steps.push(second);
  const sends = [];
  let judged = 0;
  const run = new CampaignRun(config, {
    actorModel: {
      kind: 'llm',
      complete: async (purpose) =>
        purpose === 'enhance'
          ? { roles: config.roles.map((role) => ({ ...role, persona: {} })) }
          : {
              message: 'Please clarify the assigned child and due time.',
              done: false,
            },
    },
    judgeModel: {
      kind: 'llm',
      complete: async () => ({
        verdict: judged++ ? 'pass' : 'fail',
        goalComplete: true,
        category: 'wrong_target',
        reason: 'Actual check',
      }),
    },
    adapter: {
      kind: 'http',
      config: {},
      send: async (input) => {
        sends.push(input);
        return {
          text: sends.length === 1 ? 'Wrong reply' : 'Corrected reply',
          status: 200,
        };
      },
      verify: async () => ({ status: 'passed', checks: [], evidence: {} }),
    },
  });
  const result = await run.start();
  assert.equal(result.status, 'failed');
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[1].status, 'passed');
  assert.equal(sends[0].conversationId, sends[1].conversationId);
  assert.ok(sends[1].history.some((turn) => turn.content === 'Wrong reply'));
  assert.notEqual(sends[0].messageId, sends[1].messageId);
});
test('non-gating follow-ups cannot follow writes, switch actors, export unverified facts or form cycles', () => {
  for (const change of [
    { first: { effect: 'write' }, second: {} },
    { first: {}, second: { effect: 'write' } },
    { first: {}, second: { exports: { id: 'savedId' } } },
    { first: { after: ['second'] }, second: {} },
  ]) {
    const first = {
      id: 'first',
      actorId: 'parent',
      goal: 'Read',
      effect: 'read',
      ...change.first,
    };
    const second = {
      id: 'second',
      actorId: 'parent',
      goal: 'Clarify',
      effect: 'read',
      after: ['first'],
      ...change.second,
    };
    const value = campaign(first);
    value.scenarios[0].steps.push(second);
    assert.throws(() => validateCampaign(value), /Non-gating|cycle/);
  }
});

test('eventual effect settling repeats GET observers only and never delays a pre-action snapshot', async () => {
  const config = structuredClone(adapterConfig);
  config.verifiers.both.settleAttempts = 3;
  config.verifiers.both.settleIntervalMs = 0;
  let reads = 0;
  const adapter = new HttpConversationAdapter(config, {
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      const path = new URL(url).pathname;
      if (path === '/me') return new Response(JSON.stringify(context));
      reads++;
      return new Response(
        JSON.stringify({
          tasks:
            reads <= 2
              ? []
              : [
                  {
                    name: path.endsWith('milo') ? 'Read' : 'Maths',
                    childId: path.endsWith('milo') ? 'milo' : 'nora',
                  },
                ],
        }),
      );
    },
  });
  const before = await adapter.prepareStep(input);
  assert.equal(reads, 2);
  assert.equal(before.milo.tasks.length, 0);
  const result = await adapter.verify(input);
  assert.equal(result.status, 'passed');
  assert.equal(reads, 4);
});

test('an uncertain product request blocks a planned read-only follow-up rather than replaying it', async () => {
  const first = { id: 'initial', actorId: 'parent', goal: 'Read', maxTurns: 1 };
  const second = {
    id: 'followup',
    actorId: 'parent',
    goal: 'Clarify',
    after: ['initial'],
    maxTurns: 1,
  };
  const value = campaign(first);
  value.scenarios[0].steps.push(second);
  let sent = 0;
  const run = new CampaignRun(value, {
    actorModel: {
      kind: 'llm',
      complete: async (purpose) =>
        purpose === 'enhance'
          ? { roles: value.roles.map((r) => ({ ...r, persona: {} })) }
          : { message: 'Show my tasks', done: false },
    },
    adapter: {
      kind: 'http',
      config: {},
      send: async () => {
        sent++;
        throw Object.assign(new Error('Receipt unknown'), {
          outcomeUnknown: true,
        });
      },
    },
  });
  const result = await run.start();
  assert.equal(sent, 1);
  assert.equal(result.steps[0].status, 'outcome_unknown');
  assert.equal(result.steps[1].status, 'blocked');
  assert.equal(result.qualified, false);
});
