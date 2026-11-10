import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEffectProof } from '../src/effect-proof.mjs';
import { createLab } from '../src/index.mjs';

const qualifiedRun = () => ({
  id: 'fresh-run',
  name: 'Fresh product qualification',
  startedAt: '2026-11-09T12:00:00.000Z',
  target: 'basanti',
  targetSourceRevision: 'b'.repeat(40),
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
  assert.equal(proof.source_revision, 'b'.repeat(40));
  assert.equal(proof.effect_verified, true);
  assert.equal(proof.verifier_client_id, 'conversation-roleplay-feet');
  assert.ok(!JSON.stringify(proof).includes('meal-request'));
});

test('proofs bind the archived product commit even when the running lab has changed', () => {
  const proof = createEffectProof(qualifiedRun(), {
    proposalId: `repair_${'a'.repeat(32)}`,
    stepId: 'meal-request',
    revision: 'f'.repeat(40),
    signingKey: 'roleplay-effect-proof-key-long-enough',
  });
  assert.equal(proof.source_revision, 'b'.repeat(40));
  const run = qualifiedRun();
  delete run.targetSourceRevision;
  assert.throws(() => createEffectProof(run, {
    proposalId: `repair_${'a'.repeat(32)}`,
    stepId: 'meal-request',
    revision: 'f'.repeat(40),
    signingKey: 'roleplay-effect-proof-key-long-enough',
  }), /saved tested product source revision/);
});

test('the HTTP signing endpoint uses the archived product revision and refuses legacy archives', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-product-proof-'));
  const run = qualifiedRun();
  writeFileSync(join(directory, `${run.id}.json`), JSON.stringify(run));
  const legacy = { ...run, id: 'legacy-run' };
  delete legacy.targetSourceRevision;
  writeFileSync(join(directory, `${legacy.id}.json`), JSON.stringify(legacy));
  const lab = createLab({}, {
    directory,
    env: {
      ROLEPLAY_REVISION: 'f'.repeat(40),
      ROLEPLAY_EFFECT_PROOF_SIGNING_KEY: 'roleplay-effect-proof-key-long-enough',
    },
  });
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  t.after(() => lab.server.close());
  const origin = `http://127.0.0.1:${lab.server.address().port}`;
  const meta = await (await fetch(origin + '/api/meta')).json();
  const request = {
    method: 'POST',
    headers: { 'X-Roleplay-Token': meta.csrf },
    body: JSON.stringify({
      proposalId: `repair_${'a'.repeat(32)}`,
      stepId: 'meal-request',
      revision: 'f'.repeat(40),
    }),
  };
  const signed = await fetch(`${origin}/api/runs/${run.id}/effect-proof`, request);
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).source_revision, 'b'.repeat(40));
  const rejected = await fetch(`${origin}/api/runs/${legacy.id}/effect-proof`, request);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /saved tested product source revision/);
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
