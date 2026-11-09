import test from 'node:test';
import assert from 'node:assert/strict';
import { createEffectProof } from '../src/effect-proof.mjs';

const qualifiedRun = () => ({
  id: 'fresh-run',
  target: 'basanti',
  status: 'completed',
  qualified: true,
  steps: [
    {
      id: 'meal-request',
      scenarioId: 'meal-plan',
      status: 'passed',
      verification: { status: 'passed' },
      judgment: { verdict: 'pass', goalComplete: true },
      instructionResults: [{ id: 'one', status: 'passed' }],
    },
  ],
});

test('qualified fresh run emits one deterministic content-free signed proof', () => {
  const proof = createEffectProof(qualifiedRun(), {
    proposalId: `repair_${'a'.repeat(32)}`,
    stepId: 'meal-request',
    revision: 'b'.repeat(40),
    signingKey: 'roleplay-effect-proof-key-long-enough',
    clock: () => new Date('2026-11-09T12:00:00.000Z'),
  });

  assert.match(proof.fresh_trace_id, /^trace\.roleplay\.[a-f0-9]{64}$/);
  assert.match(proof.evidence_digest, /^[a-f0-9]{64}$/);
  assert.match(proof.signature, /^[a-f0-9]{64}$/);
  assert.equal(proof.source_product, 'basanti');
  assert.equal(proof.effect_verified, true);
  assert.equal(proof.verifier_client_id, 'conversation-roleplay-feet');
  assert.ok(!JSON.stringify(proof).includes('meal-request'));
});

test('failed or simulated runs cannot sign effect proof', () => {
  const run = qualifiedRun();
  run.steps[0].verification.status = 'failed';
  assert.throws(
    () =>
      createEffectProof(run, {
        proposalId: `repair_${'a'.repeat(32)}`,
        stepId: 'meal-request',
        revision: 'b'.repeat(40),
        signingKey: 'roleplay-effect-proof-key-long-enough',
      }),
    /did not pass every independent gate/,
  );
});
