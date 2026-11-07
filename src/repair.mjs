/** HAI boundary: preserve a reviewed capability goal, correlate one submission, validate proposals, never auto-promote. */
import { createHash } from 'node:crypto';
import {
  assert,
  envHeaders,
  isObject,
  jsonRequest,
  now,
  sleep,
} from './util.mjs';

import {
  prepareRepairAnswers,
  resolveProviderQuestions,
  DEFAULT_PROPOSAL_PROTOCOL,
} from './clarifications.mjs';

const allowedCategories = new Set(['missing_capability']);
const allowedMethods = new Set(['get', 'post', 'put', 'delete']);
export function validateRepairContract(contract) {
  assert(
    isObject(contract) &&
      typeof contract.summary === 'string' &&
      contract.summary.length > 0 &&
      contract.summary.length <= 1000,
    'Repair needs a bounded, operator-authored summary',
  );
  assert(
    typeof contract.role === 'string' &&
      Array.isArray(contract.operations) &&
      contract.operations.length > 0 &&
      contract.operations.length <= 160,
    'Repair needs an explicit role and operation scope',
  );
  assert(
    Array.isArray(contract.expectedOperationIds) &&
      contract.expectedOperationIds.length > 0,
    'Repair must preserve intended operation IDs',
  );
  for (const operation of contract.operations) {
    assert(
      operation.id &&
        operation.apiPath?.startsWith('/api/') &&
        allowedMethods.has(operation.apiMethod) &&
        ['read', 'write', 'delete'].includes(operation.category),
      'Invalid repair operation',
    );
    assert(
      operation.roles?.includes(contract.role) &&
        typeof operation.requiresConfirmation === 'boolean',
      'Repair operation role/confirmation mismatch',
    );
  }
  assert(
    contract.expectedOperationIds.every((id) =>
      contract.operations.some((op) => op.id === id),
    ),
    'Expected repair operation not in scope',
  );
  // This is deliberately authored generic material, not automatic transcript scrubbing.
  assert(
    !/(?:Bearer\s|eyJ[A-Za-z0-9_-]+\.|https?:\/\/|\b\+?\d{10,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(
      contract.summary,
    ),
    'Repair summary contains private or credential-shaped material',
  );
  return contract;
}

export function validateProposal(
  value,
  contract,
  protocol = 'piggybank.api_capability_proposal.v1',
) {
  if (
    !isObject(value) ||
    value.kind !== protocol ||
    Object.keys(value).some((key) => !['kind', 'capability'].includes(key))
  )
    return {
      valid: false,
      reason: 'Provider did not return the negotiated declarative proposal',
    };
  const cap = value.capability;
  const fields = [
    'name',
    'description',
    'roles',
    'category',
    'parameters',
    'apiMethod',
    'apiPath',
    'requiresConfirmation',
    'reason',
  ];
  if (
    !isObject(cap) ||
    Object.keys(cap).some((key) => !fields.includes(key)) ||
    !/^[a-z][a-z0-9_]{2,80}$/.test(cap.name) ||
    typeof cap.description !== 'string' ||
    !isObject(cap.parameters)
  )
    return {
      valid: false,
      reason: 'Malformed or executable capability payload',
    };
  const operation = contract.operations.find(
    (op) =>
      contract.expectedOperationIds.includes(op.id) &&
      op.apiPath === cap.apiPath &&
      op.apiMethod === cap.apiMethod,
  );
  if (
    !operation ||
    cap.category !== operation.category ||
    JSON.stringify(cap.roles) !== JSON.stringify([contract.role]) ||
    cap.requiresConfirmation !== operation.requiresConfirmation
  )
    return {
      valid: false,
      reason:
        'Proposal does not match the original expected operation, role or confirmation boundary',
    };
  for (const [name, definition] of Object.entries(cap.parameters)) {
    if (
      !/^[A-Za-z][\w]{0,80}$/.test(name) ||
      !isObject(definition) ||
      !['string', 'number', 'boolean'].includes(definition.type) ||
      typeof definition.description !== 'string' ||
      Object.keys(definition).some(
        (key) => !['type', 'description', 'required'].includes(key),
      )
    )
      return { valid: false, reason: 'Invalid declarative parameter contract' };
  }
  return { valid: true, operationId: operation.id };
}

export class HaiRepairAdapter {
  constructor(config, { env = process.env, fetchImpl, getHeaders } = {}) {
    this.config = config;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.getHeaders = getHeaders;
    this.attempts = new Map();
  }
  preflight(contract, answers) {
    validateRepairContract(contract);
    const secrets = Object.entries(this.env)
      .filter(([key]) => /(?:TOKEN|SECRET|KEY|PASSWORD)/i.test(key))
      .map(([, value]) => value);
    return prepareRepairAnswers(contract, {
      protocol: this.config?.protocol ?? DEFAULT_PROPOSAL_PROTOCOL,
      answers,
      secrets,
    });
  }
  async repair(input) {
    const key = JSON.stringify([input.runId, input.scenarioId, input.stepId]);
    if (!this.attempts.has(key)) this.attempts.set(key, this.perform(input));
    const result = await this.attempts.get(key);
    if (['needs_preflight', 'disabled', 'not_eligible'].includes(result.status))
      this.attempts.delete(key);
    return structuredClone(result);
  }
  async perform({
    category,
    contract,
    clarificationAnswers,
    runId,
    scenarioId,
    stepId,
    checkpoint,
    signal,
    emit = () => {},
  }) {
    if (!allowedCategories.has(category))
      return {
        status: 'not_eligible',
        reason:
          'Only a confirmed missing capability can request a capability proposal',
      };
    if (!this.config?.enabled)
      return {
        status: 'disabled',
        reason: 'HAI integration is not configured',
      };
    const prepared = this.preflight(contract, clarificationAnswers);
    if (!prepared.ready)
      return {
        status: 'needs_preflight',
        effectVerified: false,
        attempts: 0,
        missingAnswers: prepared.missing,
        questions: prepared.questions,
        reason:
          'Answer required HAI questions before starting; no provider task submitted',
      };
    assert(
      this.config.contractVerified === true,
      'HAI contract/service identity must be reviewed before enabling',
    );
    const protocol =
      this.config.protocol ?? 'piggybank.api_capability_proposal.v1';
    const selected = contract.operations
      .filter((op) => contract.expectedOperationIds.includes(op.id))
      .map(
        ({
          id,
          apiPath,
          apiMethod,
          roles,
          category,
          requiresConfirmation,
        }) => ({
          id,
          apiPath,
          apiMethod,
          roles,
          category,
          requiresConfirmation,
        }),
      );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          runId,
          scenarioId,
          stepId,
          contract,
          answers: prepared.answers,
        }),
      )
      .digest('hex');
    const receipt = {
      status: 'submitting',
      fingerprint,
      attempts: 1,
      at: now(),
      effectVerified: false,
    };
    const request = async (path, options = {}) =>
      jsonRequest(new URL(path, this.config.baseUrl), {
        headers: this.getHeaders
          ? await this.getHeaders(signal)
          : envHeaders(this.config.headersEnv, this.env),
        fetchImpl: this.fetchImpl,
        signal,
        ...options,
      });
    const description = `Return only a typed ${protocol} declarative capability proposal. Never execute, emit code, request private data or claim completion. Preserve this reviewed goal: ${contract.summary}. Use only the expected operations supplied in context. Return {kind,capability:{name,description,roles,category,parameters,apiMethod,apiPath,requiresConfirmation,reason}}.`;
    assert(
      description.length + prepared.appendix.length <= 4096,
      'HAI request brief exceeds the provider limit',
    );
    await checkpoint(receipt); // Persist intent before the only provider task POST.
    try {
      const accepted = await request('/v1/tasks', {
        method: 'POST',
        body: {
          description: description + prepared.appendix,
          context: {
            ...(protocol !== DEFAULT_PROPOSAL_PROTOCOL && {
              skip_clarification: true,
              clarification_answers: prepared.answers,
              input_data: prepared.inputData,
            }),
            execution_mode: 'build',
            proposal_protocol: protocol,
            conversationId: runId,
            goalId: `${scenarioId}:${stepId}`,
            capability_scope: {
              version: 1,
              role: contract.role,
              primitiveSkills: [],
              apiPaths: [...new Set(selected.map((op) => op.apiPath))],
              apiOperations: selected,
            },
          },
        },
      });
      assert(
        accepted.status === 202 &&
          typeof accepted.data.run_id === 'string' &&
          accepted.data.run_id.length > 0,
        'HAI acceptance receipt is invalid',
      );
      receipt.providerRunId = accepted.data.run_id;
      receipt.status = 'polling';
      await checkpoint(receipt);
      emit(receipt);
      const maxPolls = this.config.maxPolls ?? 20;
      for (let poll = 0; poll < maxPolls; poll++) {
        await sleep(this.config.pollIntervalMs ?? 3000, signal);
        const { data } = await request(
          `/v1/runs/${encodeURIComponent(receipt.providerRunId)}`,
        );
        assert(
          data.run_id === receipt.providerRunId,
          'HAI run identity mismatch',
        );
        receipt.providerStatus = data.status;
        receipt.polls = poll + 1;
        if (data.status === 'succeeded') {
          const validation = validateProposal(data.result, contract, protocol);
          Object.assign(receipt, {
            status: validation.valid ? 'proposal_ready' : 'rejected',
            validation,
            ...(validation.valid ? { proposal: data.result } : {}),
          });
          // A valid proposal is still NOT an installed skill or verified repair.
          receipt.reason = validation.valid
            ? 'Requires product sandbox, original-scenario verification and controlled registry promotion'
            : validation.reason;
          await checkpoint(receipt);
          emit(receipt);
          return receipt;
        }
        if (data.status === 'awaiting_clarification') {
          const resolved = resolveProviderQuestions(data.questions, prepared);
          if (!resolved.ready) {
            Object.assign(receipt, {
              status: 'needs_clarification',
              missingAnswers: resolved.missing,
              questions: resolved.questions,
              reason:
                'Provider asked outside the reviewed answer brief; no guessed answers or approvals sent',
            });
            await checkpoint(receipt);
            emit(receipt);
            return receipt;
          }
          const batch = createHash('sha256')
            .update(
              JSON.stringify({
                questions: resolved.questions
                  .map(({ id, inputField, reviewedQuestionId }) => ({
                    id,
                    inputField,
                    reviewedQuestionId,
                  }))
                  .sort((a, b) => a.id.localeCompare(b.id)),
                answers: Object.entries(resolved.answers).sort(([a], [b]) =>
                  a.localeCompare(b),
                ),
              }),
            )
            .digest('hex');
          receipt.clarifications ??= [];
          if (receipt.clarifications.some((item) => item.fingerprint === batch))
            continue;
          if (receipt.clarifications.length >= 3) {
            Object.assign(receipt, {
              status: 'needs_clarification',
              questions: resolved.questions,
              reason:
                'Reviewed answer round limit reached; no further answers posted',
            });
            await checkpoint(receipt);
            emit(receipt);
            return receipt;
          }
          const entry = {
            fingerprint: batch,
            status: 'submitting',
            answers: resolved.answers,
            at: now(),
          };
          receipt.clarifications.push(entry);
          receipt.status = 'answering_clarification';
          await checkpoint(receipt);
          emit(receipt);
          try {
            const reply = await request(
              `/v1/runs/${encodeURIComponent(receipt.providerRunId)}/clarify`,
              {
                method: 'POST',
                body: { answers: resolved.answers },
              },
            );
            assert(
              reply.status === 200 &&
                reply.data.run_id === receipt.providerRunId &&
                reply.data.status === 'resumed',
              'HAI clarification receipt is invalid',
            );
            entry.status = 'answered';
            receipt.status = 'polling';
            await checkpoint(receipt);
            emit(receipt);
          } catch (error) {
            entry.status =
              error.status >= 400 && error.status < 500
                ? 'rejected'
                : 'outcome_unknown';
            receipt.status =
              entry.status === 'rejected'
                ? 'clarification_rejected'
                : 'clarification_submission_unknown';
            receipt.reason =
              'Inspect the existing provider run; this answer batch will not be posted again';
            await checkpoint(receipt);
            emit(receipt);
            return receipt;
          }
          continue;
        }
        if (
          data.status === 'failed' &&
          typeof data.completed_at === 'string' &&
          Number.isFinite(Date.parse(data.completed_at))
        ) {
          receipt.status = 'failed';
          receipt.reason = 'Provider recorded a terminal failure';
          await checkpoint(receipt);
          return receipt;
        }
        if (
          !['queued', 'running', 'delegated', 'failed'].includes(data.status)
        ) {
          receipt.status = 'unknown_provider_state';
          await checkpoint(receipt);
          return receipt;
        }
        await checkpoint(receipt);
        emit(receipt);
      }
      receipt.status = 'poll_limit';
      receipt.reason =
        'Existing provider run may still be active; do not submit again';
    } catch (error) {
      receipt.status = receipt.providerRunId
        ? 'poll_unavailable'
        : error.status >= 400 && error.status < 500
          ? 'submission_rejected'
          : 'submission_unknown';
      receipt.reason = receipt.providerRunId
        ? 'Inspect the existing provider run; no resubmission'
        : 'Submission outcome is uncertain; never submit again automatically';
      if (receipt.status === 'submission_rejected')
        receipt.reason = `Provider rejected the request with HTTP ${error.status}; inspect configuration rather than resubmitting`;
    }
    await checkpoint(receipt);
    emit(receipt);
    return receipt;
  }
}

export class DemoRepairAdapter {
  async repair({ category, checkpoint, emit = () => {} }) {
    if (category !== 'missing_capability')
      return { status: 'not_eligible', effectVerified: false };
    const receipt = {
      status: 'proposal_ready',
      demo: true,
      attempts: 1,
      effectVerified: false,
      reason:
        'Simulated proposal only. No HAI job, skill installation or verified fix.',
    };
    await checkpoint(receipt);
    emit(receipt);
    return receipt;
  }
}
