/** Preserve original intent and service correlation; never equate provider completion with a repaired product. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HaiRepairAdapter, validateProposal } from '../src/index.mjs';

const contract = {
  summary:
    'Read assigned lesson feedback with its lesson identity and child scope.',
  role: 'coach',
  expectedOperationIds: ['lesson-feedback-read'],
  operations: [
    {
      id: 'lesson-feedback-read',
      apiPath: '/api/lessons/feedback',
      apiMethod: 'get',
      roles: ['coach'],
      category: 'read',
      requiresConfirmation: false,
    },
    {
      id: 'unrelated-availability',
      apiPath: '/api/schedules/availability',
      apiMethod: 'get',
      roles: ['coach'],
      category: 'read',
      requiresConfirmation: false,
    },
  ],
};
const proposal = () => ({
  kind: 'piggybank.api_capability_proposal.v1',
  capability: {
    name: 'read_lesson_feedback',
    description: 'Read assigned lesson feedback.',
    roles: ['coach'],
    category: 'read',
    parameters: {},
    apiMethod: 'get',
    apiPath: '/api/lessons/feedback',
    requiresConfirmation: false,
  },
});
const config = {
  enabled: true,
  contractVerified: true,
  baseUrl: 'http://hai.test',
  maxPolls: 3,
  pollIntervalMs: 1,
};
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

test('rejects an unrelated valid-looking skill, role widening, executable payloads and changed confirmation', () => {
  const unrelated = proposal();
  unrelated.capability.apiPath = '/api/schedules/availability';
  assert.equal(validateProposal(unrelated, contract).valid, false);
  const widened = proposal();
  widened.capability.roles.push('parent');
  assert.equal(validateProposal(widened, contract).valid, false);
  const executable = proposal();
  executable.capability.code = 'run()';
  assert.equal(validateProposal(executable, contract).valid, false);
  const confirmation = proposal();
  confirmation.capability.requiresConfirmation = true;
  assert.equal(validateProposal(confirmation, contract).valid, false);
  assert.equal(validateProposal(proposal(), contract).valid, true);
});

test('one scoped submission keeps the reviewed goal and only expected operations; provider success is a proposal', async () => {
  const calls = [],
    checkpoints = [];
  const client = new HaiRepairAdapter(config, {
    fetchImpl: async (url, options) => {
      calls.push({ path: new URL(url).pathname, options });
      return calls.length === 1
        ? response({ run_id: 'provider-42', status: 'queued' }, 202)
        : response({
            run_id: 'provider-42',
            status: 'succeeded',
            result: proposal(),
          });
    },
  });
  const result = await client.repair({
    category: 'missing_capability',
    contract,
    runId: 'run-1',
    scenarioId: 'story',
    stepId: 'feedback',
    checkpoint: async (value) => checkpoints.push(structuredClone(value)),
  });
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.description, /lesson feedback/);
  assert.deepEqual(
    body.context.capability_scope.apiOperations.map((op) => op.id),
    ['lesson-feedback-read'],
  );
  assert.equal(checkpoints[0].status, 'submitting');
  assert.equal(checkpoints[0].attempts, 1);
  assert.equal(result.status, 'proposal_ready');
  assert.equal(result.effectVerified, false);
  assert.equal(
    calls.filter((call) => call.options.method === 'POST').length,
    1,
  );
});

test('transient failed state without terminal timestamp is polled on the same run', async () => {
  let calls = 0;
  const client = new HaiRepairAdapter(config, {
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? response({ run_id: 'same-run' }, 202)
        : calls === 2
          ? response({ run_id: 'same-run', status: 'failed' })
          : response({
              run_id: 'same-run',
              status: 'succeeded',
              result: proposal(),
            });
    },
  });
  const result = await client.repair({
    category: 'missing_capability',
    contract,
    runId: 'run',
    scenarioId: 's',
    stepId: 'x',
    checkpoint: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(result.providerRunId, 'same-run');
  assert.equal(result.status, 'proposal_ready');
});

test('submission timeout is quarantined without retry; correct policy denials make zero provider requests', async () => {
  let calls = 0;
  const client = new HaiRepairAdapter(config, {
    fetchImpl: async () => {
      calls++;
      throw new Error('timeout');
    },
  });
  const input = {
    category: 'missing_capability',
    contract,
    runId: 'r',
    scenarioId: 's',
    stepId: 'x',
    checkpoint: async () => {},
  };
  const result = await client.repair(input);
  assert.equal(result.status, 'submission_unknown');
  assert.equal(calls, 1);
  const duplicate = await client.repair(input);
  assert.equal(duplicate.status, 'submission_unknown');
  assert.equal(calls, 1);
  const denial = await client.repair({
    ...input,
    stepId: 'different-denied-step',
    category: 'policy_denial',
  });
  assert.equal(denial.status, 'not_eligible');
  assert.equal(calls, 1);
});

test('wrong provider run and clarification cannot be treated as a repaired product', async () => {
  for (const provider of [
    { run_id: 'wrong', status: 'succeeded', result: proposal() },
    { run_id: 'expected', status: 'awaiting_clarification' },
  ]) {
    let calls = 0;
    const client = new HaiRepairAdapter(config, {
      fetchImpl: async () =>
        ++calls === 1
          ? response({ run_id: 'expected' }, 202)
          : response(provider),
    });
    const result = await client.repair({
      category: 'missing_capability',
      contract,
      runId: 'r',
      scenarioId: 's',
      stepId: 'x',
      checkpoint: async () => {},
    });
    assert.equal(result.effectVerified, false);
    assert.notEqual(result.status, 'proposal_ready');
    assert.equal(calls, 2);
  }
});
