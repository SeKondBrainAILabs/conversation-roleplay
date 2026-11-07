/** Validate human-authored and model-generated campaigns before any target calls. */
import { assert, clone, isObject } from './util.mjs';
import { isDeepStrictEqual } from 'node:util';

const identifier = (value) =>
  typeof value === 'string' && /^[a-zA-Z][\w-]{0,63}$/.test(value);
const text = (value, max = 4000) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export const LIMITS = {
  roles: 30,
  scenarios: 100,
  steps: 100,
  turns: 12,
  concurrency: 20,
};

export function validateCampaign(input) {
  assert(isObject(input) && input.version === 1, 'Campaign version must be 1');
  assert(
    text(input.name, 160) && text(input.target, 64),
    'Campaign needs a name and target',
  );
  assert(
    Array.isArray(input.roles) &&
      input.roles.length > 0 &&
      input.roles.length <= LIMITS.roles,
    'Supply 1–30 roles',
  );
  const roles = new Set();
  for (const role of input.roles) {
    assert(
      identifier(role.id) && !roles.has(role.id),
      'Role IDs must be unique identifiers',
    );
    assert(
      text(role.name, 100) && text(role.description, 4000),
      'Each role needs a name and description',
    );
    roles.add(role.id);
  }
  assert(
    Array.isArray(input.scenarios) &&
      input.scenarios.length > 0 &&
      input.scenarios.length <= LIMITS.scenarios,
    'Supply 1–100 scenarios',
  );
  if (input.repairAnswers !== undefined)
    assert(
      isObject(input.repairAnswers) &&
        Object.keys(input.repairAnswers).length <= 100 &&
        Object.entries(input.repairAnswers).every(
          ([key, values]) =>
            identifier(key) &&
            isObject(values) &&
            Object.keys(values).length <= 12 &&
            Object.entries(values).every(
              ([id, answer]) =>
                identifier(id) &&
                typeof answer === 'string' &&
                answer.length <= 500,
            ),
        ),
      'Invalid reviewed HAI answer map',
    );
  const scenarios = new Set();
  const result = clone(input);
  result.concurrency ??= 4;
  result.maxModelCalls ??= 250;
  result.maxDurationMs ??= 1_800_000;
  assert(
    Number.isInteger(result.concurrency) &&
      result.concurrency >= 1 &&
      result.concurrency <= LIMITS.concurrency,
    'Concurrency must be 1–20',
  );
  assert(
    Number.isInteger(result.maxModelCalls) &&
      result.maxModelCalls >= 1 &&
      result.maxModelCalls <= 5000,
    'Model budget must be 1–5000 calls',
  );
  assert(
    Number.isInteger(result.maxDurationMs) &&
      result.maxDurationMs >= 1000 &&
      result.maxDurationMs <= 10_800_000,
    'Duration budget must be 1 second–3 hours',
  );
  for (const scenario of result.scenarios) {
    assert(
      identifier(scenario.id) &&
        !scenarios.has(scenario.id) &&
        text(scenario.title, 200),
      'Scenarios need unique IDs and titles',
    );
    scenarios.add(scenario.id);
    scenario.worldId ??= scenario.id;
    assert(identifier(scenario.worldId), 'World IDs must be identifiers');
    assert(
      Array.isArray(scenario.steps) &&
        scenario.steps.length > 0 &&
        scenario.steps.length <= LIMITS.steps,
      'Supply 1–100 steps per scenario',
    );
    const steps = new Map();
    for (const step of scenario.steps) {
      assert(
        identifier(step.id) && !steps.has(step.id),
        'Step IDs must be unique within a scenario',
      );
      assert(
        roles.has(step.actorId) && text(step.goal),
        'Every step needs a known actor and bounded goal',
      );
      step.kind ??= 'conversation';
      step.effect ??= 'read';
      step.dependsOn ??= [];
      step.maxTurns ??= 4;
      assert(
        ['conversation', 'fixture'].includes(step.kind),
        'Unknown step kind',
      );
      assert(
        ['read', 'write', 'none'].includes(step.effect),
        'Unknown effect kind',
      );
      assert(
        Array.isArray(step.dependsOn) &&
          new Set(step.dependsOn).size === step.dependsOn.length,
        'Invalid dependencies',
      );
      assert(
        Number.isInteger(step.maxTurns) &&
          step.maxTurns > 0 &&
          step.maxTurns <= LIMITS.turns,
        'Turn budget must be 1–12',
      );
      assert(
        step.verifierId === undefined || identifier(step.verifierId),
        'Invalid verifier ID',
      );
      assert(
        step.repairContractId === undefined ||
          identifier(step.repairContractId),
        'Invalid repair contract ID',
      );
      if (step.kind === 'fixture')
        assert(
          identifier(step.fixtureId),
          'Fixture steps need a configured fixture ID',
        );
      if (step.exports !== undefined)
        assert(
          isObject(step.exports) &&
            Object.entries(step.exports).every(
              ([key, val]) => identifier(key) && typeof val === 'string',
            ),
          'Exports must be named JSON paths into verified evidence',
        );
      steps.set(step.id, step);
    }
    const visit = (id, visiting = new Set(), visited = new Set()) => {
      assert(steps.has(id), `Unknown dependency ${id}`);
      assert(!visiting.has(id), 'Scenario dependencies contain a cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of steps.get(id).dependsOn) visit(dep, visiting, visited);
      visiting.delete(id);
      visited.add(id);
    };
    for (const step of steps.values()) visit(step.id);
  }
  return result;
}

/** Model planning may only use roles and operation hooks supplied by the operator. */
export function validateGeneratedCampaign(
  campaign,
  {
    target,
    roles,
    verifierIds = [],
    fixtureIds = [],
    repairContractIds = [],
    worlds,
  },
) {
  assert(
    campaign.repairAnswers === undefined,
    'Planner cannot author reviewed HAI answers',
  );
  assert(campaign.target === target, 'Planner changed the target');
  assert(
    isDeepStrictEqual(campaign.roles, roles),
    'Planner changed the supplied roles',
  );
  const valid = validateCampaign(campaign);
  for (const scenario of valid.scenarios)
    for (const step of scenario.steps) {
      if (worlds)
        assert(
          worlds.some(
            (world) =>
              world.id === scenario.worldId &&
              world.actorIds.includes(step.actorId),
          ),
          'Planner invented a QA world or used an unbound actor',
        );
      assert(
        !step.verifierId || verifierIds.includes(step.verifierId),
        'Planner invented a verifier',
      );
      assert(
        !step.fixtureId || fixtureIds.includes(step.fixtureId),
        'Planner invented a fixture',
      );
      assert(
        !step.repairContractId ||
          repairContractIds.includes(step.repairContractId),
        'Planner invented a repair contract',
      );
    }
  return valid;
}
