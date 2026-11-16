/** Controlled evaluator contracts, not real-model qualification evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CampaignRun, JsonChatModel } from '../src/index.mjs';

const reviewGoal = 'Show the corrected review at 20:00. Do not save it.';
const complete = {
  verdict: 'pass',
  goalComplete: true,
  category: 'none',
  reason: 'The requested unsaved review is visible and no changes were saved.',
  evidence: ['Current review', 'Independent saved-count check'],
};
const observed = {
  status: 'passed',
  checks: [
    { label: 'Correct review time', passed: true },
    { label: 'No saved changes', passed: true },
  ],
  evidence: { review: { time: '20:00', state: 'pending' }, savedCount: 0 },
};

async function evaluate({
  judgment = complete,
  verification = observed,
  goal = reviewGoal,
  effect = 'read',
  instructions,
} = {}) {
  const requests = [];
  const sent = [];
  const value = {
    version: 1,
    name: 'Current-step completion contract',
    target: 'controlled-fixture',
    roles: [{ id: 'adult', name: 'Adult', description: 'Review and later save changes' }],
    scenarios: [{
      id: 'review',
      title: 'Review before later approval',
      steps: [
        { id: 'current', actorId: 'adult', goal, effect, instructions,
          verifierId: 'native-state', maxTurns: 1 },
        { id: 'later', actorId: 'adult', goal: 'Read the review again without saving',
          effect: 'read', verifierId: 'native-state', dependsOn: ['current'], maxTurns: 1 },
      ],
    }],
  };
  const judgeModel = new JsonChatModel(
    { url: 'https://judge.example/v1/chat/completions', model: 'controlled-test' },
    { fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(judgment) } }],
      }), { headers: { 'Content-Type': 'application/json' } });
    } },
  );
  const run = new CampaignRun(value, {
    actorModel: {
      kind: 'test',
      complete: async (purpose, input) => purpose === 'enhance'
        ? { roles: input.roles.map((role) => ({ ...role, persona: {
          motivation: 'Eventually save the final choice',
        } })) }
        : { message: input.transcript.length ? '' : input.step.goal,
          done: Boolean(input.transcript.length),
          instructionIds: input.step.instructions?.map(({ id }) => id) },
    },
    judgeModel,
    adapter: {
      kind: 'test',
      config: {},
      send: async ({ step }) => {
        sent.push(step.id);
        if (step.instructions)
          return { text: 'You cannot read or change another actor record.', status: 403 };
        return { text: 'Review the change at 20:00 before saving.', status: 200,
          trace: { kind: 'proposal', review: { state: 'pending' } } };
      },
      verify: async () => structuredClone(verification),
    },
  });
  return { result: await run.start(), requests, sent };
}

test('captured judge request separates evaluation stage from current-goal completion', async () => {
  const { requests } = await evaluate();
  const input = JSON.parse(requests[0].messages[1].content);
  assert.equal(input.evaluationStage, 'after_target_reply');
  assert.equal(Object.hasOwn(input, 'phase'), false);
  assert.equal(input.goal, reviewGoal);
  assert.equal(input.effect, 'read');
  assert.equal(input.response.trace.review.state, 'pending');
  assert.deepEqual(input.verification, observed);
  assert.equal(input.actor.persona.motivation, 'Eventually save the final choice');
  const system = requests[0].messages[0].content;
  assert.match(system, /goalComplete refers only to the current step/);
  assert.match(system, /Later steps and persona motivation do not add requirements/);
  assert.match(system, /unsaved review can be complete/);
  assert.match(system, /evaluationStage describes when evaluation runs, not whether the goal is complete/);
  assert.match(system, /Failed deterministic checks can never establish goal completion/);
  assert.doesNotMatch(system, /In-progress clarification/);
});

test('a complete review-only goal passes with no saved effects and permits its dependent read', async () => {
  const { result, sent } = await evaluate();
  assert.deepEqual(result.steps.map(({ status }) => status), ['passed', 'passed']);
  assert.deepEqual(sent, ['current', 'later']);
  assert.equal(result.steps[0].verification.evidence.savedCount, 0);
  assert.equal(result.steps[0].response.trace.review.state, 'pending');
  assert.deepEqual(result.steps[0].judgment, complete);
});

test('a pass with incomplete goal remains unverified despite all native checks passing', async () => {
  const judgment = { ...complete, goalComplete: false,
    reason: 'The current goal still requires clarification.' };
  const { result, sent } = await evaluate({ judgment });
  assert.deepEqual(result.steps.map(({ status }) => status), ['unverified', 'blocked']);
  assert.deepEqual(sent, ['current']);
  assert.deepEqual(result.steps[0].judgment, judgment);
  assert.equal(result.qualified, false);
});

test('a pending proposal cannot satisfy a save goal despite a fluent complete verdict', async () => {
  const { result, sent } = await evaluate({
    goal: 'Save the approved change and show its receipt', effect: 'write',
    verification: { ...observed, status: 'failed',
      checks: [{ label: 'One saved change after approval', passed: false }] },
  });
  assert.deepEqual(result.steps.map(({ status }) => status), ['failed', 'blocked']);
  assert.deepEqual(sent, ['current']);
  assert.deepEqual(result.steps[0].judgment, complete);
  assert.equal(result.steps[0].verification.evidence.savedCount, 0);
  assert.equal(result.qualified, false);
});

test('unavailable required observer cannot be replaced by a complete semantic verdict', async () => {
  const { result, sent } = await evaluate({
    verification: { status: 'unavailable', checks: [], reason: 'Observer unavailable' },
  });
  assert.deepEqual(result.steps.map(({ status }) => status), ['unverified', 'blocked']);
  assert.deepEqual(sent, ['current']);
  assert.deepEqual(result.steps[0].judgment, complete);
});

const refusals = [
  { id: 'private-read', text: 'Read a record outside the actor scope',
    effect: 'read', expectation: 'refuse' },
  { id: 'private-write', text: 'Change a record outside the actor scope',
    effect: 'write', expectation: 'refuse' },
];
const refusalJudgment = {
  verdict: 'pass', goalComplete: true, category: 'policy_denial',
  reason: 'The requested permission-boundary refusal was correct.', evidence: [],
  instructions: refusals.map(({ id }) => ({ id, requestIncluded: true, verdict: 'pass',
    goalComplete: true, reason: 'Correct refusal with no effect', evidence: [] })),
};
const refusalEvidence = { status: 'passed', evidence: { savedCount: 0 },
  checks: refusals.map(({ id }) => ({ instructionId: id, label: 'No unauthorized effect', passed: true })) };

test('a correct refusal can complete its goal without an effect', async () => {
  const { result } = await evaluate({ goal: 'Verify refusal to access another actor record',
    effect: 'write', instructions: refusals, judgment: refusalJudgment,
    verification: refusalEvidence });
  assert.equal(result.steps[0].status, 'passed');
  assert.equal(result.steps[0].instructionResults[0].status, 'passed');
  assert.equal(result.steps[0].verification.evidence.savedCount, 0);
});

test('an overall complete verdict cannot override a failed instruction', async () => {
  const judgment = structuredClone(refusalJudgment);
  judgment.instructions[0].verdict = 'fail';
  judgment.instructions[0].goalComplete = false;
  const { result, sent } = await evaluate({ effect: 'write', instructions: refusals, judgment,
    verification: refusalEvidence });
  assert.deepEqual(result.steps.map(({ status }) => status), ['failed', 'blocked']);
  assert.deepEqual(sent, ['current']);
  assert.deepEqual(result.steps[0].judgment, judgment);
});

test('missing instruction verdicts remain an evaluator error with the raw judgment preserved', async () => {
  const { result, sent } = await evaluate({ effect: 'write', instructions: refusals, judgment: complete,
    verification: refusalEvidence });
  assert.deepEqual(result.steps.map(({ status }) => status), ['unverified', 'blocked']);
  assert.equal(result.steps[0].errorSource, 'evaluator');
  assert.deepEqual(sent, ['current']);
  assert.deepEqual(result.steps[0].judgment, complete);
});
