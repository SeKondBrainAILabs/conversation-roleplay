/** Content-free proof that one fresh roleplay step passed independent evaluation. */
import { createHash, createHmac } from 'node:crypto';
import { assert } from './util.mjs';

const digest = (value) =>
  createHash('sha256').update(value).digest('hex');

export function createEffectProof(
  run,
  { proposalId, stepId, signingKey, clock = () => new Date() },
) {
  const revision = run?.targetSourceRevision;
  assert(
    /^repair_[a-f0-9]{32}$/.test(proposalId),
    'Effect proof needs one product-repair proposal',
  );
  assert(
    ['basanti', 'piggybank'].includes(run?.target),
    'Effect proof needs a qualified product run',
  );
  assert(
    typeof revision === 'string' && /^[0-9a-f]{40,64}$/.test(revision),
    'Effect proof needs the saved tested product source revision',
  );
  assert(signingKey?.length >= 32, 'Effect-proof signing is not configured');
  assert(
    run?.status === 'completed' && run.qualified === true,
    'Only a qualified completed run can prove an effect',
  );
  const matches = run.steps?.filter((step) => step.id === stepId) ?? [];
  assert(matches.length === 1, 'Effect proof step must be unique');
  const step = matches[0];
  assert(
    step.status === 'passed' &&
      step.verification?.status === 'passed' &&
      step.judgment?.verdict === 'pass' &&
      step.judgment?.goalComplete === true &&
      Array.isArray(step.instructionResults) &&
      step.instructionResults.length > 0 &&
      step.instructionResults.every((item) => item.status === 'passed'),
    'Effect proof step did not pass every independent gate',
  );
  const binding = JSON.stringify({
    product: run.target,
    revision,
    runId: run.id,
    scenarioId: step.scenarioId,
    stepId: step.id,
    verification: step.verification.status,
    verdict: step.judgment.verdict,
  });
  const freshTraceId = `trace.roleplay.${digest(`effect-proof\n${binding}`)}`;
  const evidenceDigest = digest(`qualified-effect\n${binding}`);
  const issuedAt = clock().toISOString();
  const canonical = [
    proposalId,
    run.target,
    freshTraceId,
    revision,
    evidenceDigest,
    'pass',
    'true',
    issuedAt,
    'conversation-roleplay-feet',
  ].join('\n');
  return {
    source_product: run.target,
    fresh_trace_id: freshTraceId,
    source_revision: revision,
    evidence_digest: evidenceDigest,
    evaluation_verdict: 'pass',
    effect_verified: true,
    issued_at: issuedAt,
    verifier_client_id: 'conversation-roleplay-feet',
    signature: createHmac('sha256', signingKey).update(canonical).digest('hex'),
  };
}
