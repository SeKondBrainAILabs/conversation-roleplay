/** Preserve each requested instruction separately from the judge's overall opinion. */
import { assert } from './util.mjs';

export function instructionResults(step, judgment, verification) {
  if (!step.instructions?.length) return [];
  const answers = judgment.instructions;
  assert(
    Array.isArray(answers) && answers.length === step.instructions.length,
    'Judge must evaluate every instruction exactly once',
  );
  assert(
    new Set(answers.map((item) => item.id)).size === answers.length &&
      answers.every((item) =>
        step.instructions.some((instruction) => instruction.id === item.id),
      ),
    'Judge returned duplicate or unknown instructions',
  );
  return step.instructions.map((instruction) => {
    const answer = answers.find((item) => item.id === instruction.id);
    assert(
      ['pass', 'fail', 'uncertain'].includes(answer.verdict) &&
        typeof answer.goalComplete === 'boolean' &&
        typeof answer.requestIncluded === 'boolean' &&
        typeof answer.reason === 'string',
      'Invalid instruction judgment',
    );
    const checks = (verification?.checks ?? []).filter(
      (check) => check.instructionId === instruction.id,
    );
    const requiresApi = (instruction.effect ?? step.effect) === 'write';
    const apiStatus = checks.length
      ? checks.every((check) => check.passed)
        ? 'passed'
        : 'failed'
      : requiresApi
        ? 'unavailable'
        : 'not_required';
    const status = !answer.requestIncluded
      ? 'invalid_request'
      : answer.verdict === 'fail' ||
          (apiStatus === 'failed' && answer.goalComplete)
        ? 'failed'
        : answer.verdict === 'pass' &&
            answer.goalComplete &&
            ['passed', 'not_required'].includes(apiStatus)
          ? 'passed'
          : 'unverified';
    return {
      id: instruction.id,
      text: instruction.text,
      expectation: instruction.expectation ?? 'complete',
      status,
      semantic: answer,
      apiStatus,
      checks,
    };
  });
}
