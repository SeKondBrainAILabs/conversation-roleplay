import test from 'node:test';
import assert from 'node:assert/strict';
import { CampaignRun, HttpConversationAdapter } from '../src/index.mjs';
import { validateIncidentContract } from '../src/incidents.mjs';

test('QA incident contracts reject classifications the deployed reporter and HAI cannot accept', () => {
  const contract = {
    product: 'piggybank',
    platformRole: 'child',
    roleIds: ['family.child'],
    incidentType: 'eval_failed',
    reasonCode: 'task_details_omitted',
  };
  assert.deepEqual(validateIncidentContract(contract), contract);
  for (const incidentType of [
    'unmapped_case',
    'unavailable_skill',
    'api_contract_missing',
    'api_execution_failed',
    'schema_invalid',
    'adapter_failed',
  ]) {
    assert.throws(
      () => validateIncidentContract({ ...contract, incidentType }),
      /evaluated failures only/,
    );
  }
});

test('a malformed later observer rejects the whole campaign before any model or product request', () => {
  let modelCalls = 0;
  let requests = 0;
  const actor = { id: 'child', name: 'Child', description: 'Child', persona: {} };
  const step = (id, verifierId) => ({
    id,
    actorId: actor.id,
    goal: 'Ask about my task and reward',
    effect: 'read',
    verifierId,
    instructions: [
      { id: 'ownChore', text: 'Ask about my task and due time.' },
      { id: 'rewardAndApproval', text: 'Ask about my reward and parent check.' },
    ],
  });
  const adapter = new HttpConversationAdapter({
    baseUrl: 'https://fixture.invalid',
    qaOnly: true,
    bindings: { world: { child: { qa: true, context: { role: 'child' } } } },
    verifiers: {
      valid: {
        path: '/tasks',
        assertions: [{ path: 'tasks', op: 'exists', instructionId: 'rewardAndApproval' }],
      },
      invalid: {
        path: '/tasks',
        assertions: [{ path: 'tasks', op: 'exists', instructionId: 'reward' }],
      },
    },
  }, {
    fetchImpl: async () => { requests++; throw Error('Unexpected product traffic'); },
  });
  assert.throws(() => new CampaignRun({
    version: 1,
    name: 'Validate all observers before starting',
    target: 'piggybank',
    roles: [actor],
    scenarios: [{
      id: 'story',
      worldId: 'world',
      title: 'Task questions',
      steps: [step('first', 'valid'), step('later', 'invalid')],
    }],
  }, {
    adapter,
    actorModel: { kind: 'llm', complete: async () => { modelCalls++; throw Error('Unexpected model traffic'); } },
  }), /Observer refers to an unknown instruction/);
  assert.equal(modelCalls, 0);
  assert.equal(requests, 0);
});
