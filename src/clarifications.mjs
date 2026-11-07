/** Reviewed pre-run answers. Provider questions never authorize new facts or permissions. */
import { assert, isObject } from './util.mjs';

export const DEFAULT_PROPOSAL_PROTOCOL = 'piggybank.api_capability_proposal.v1';
export const RESERVED_REPAIR_STATES = new Set([
  'submitting',
  'submission_unknown',
  'polling',
  'poll_interrupted',
  'poll_unavailable',
  'poll_limit',
  'needs_clarification',
  'answering_clarification',
  'clarification_submission_unknown',
  'clarification_rejected',
  'unknown_provider_state',
]);
const id = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z][\w-]{0,63}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value);
const normalized = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();
export function reviewedText(value, label, secrets = [], max = 500) {
  assert(
    typeof value === 'string' &&
      value.trim() &&
      value.length <= max &&
      !/[\u0000-\u0008\u000b-\u001f]/.test(value),
    `${label} needs bounded text`,
  );
  assert(
    !/(?:Bearer\s|eyJ[A-Za-z0-9_-]+\.|https?:\/\/|\b\+?\d{10,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(
      value,
    ) &&
      !secrets.some(
        (s) => typeof s === 'string' && s.length >= 8 && value.includes(s),
      ),
    `${label} must contain generic reviewed facts, not private data or credentials`,
  );
  return value.trim();
}
function inputValue(value, type = 'string') {
  if (type === 'string') return value;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('A typed HAI input must be valid JSON');
  }
  assert(
    (type === 'number' &&
      typeof parsed === 'number' &&
      Number.isFinite(parsed)) ||
      (type === 'boolean' && typeof parsed === 'boolean'),
    'HAI answer does not match its declared input type',
  );
  return parsed;
}
export function prepareRepairAnswers(
  contract,
  { protocol = DEFAULT_PROPOSAL_PROTOCOL, answers = {}, secrets = [] } = {},
) {
  reviewedText(contract.summary, 'Repair goal', secrets, 1000);
  reviewedText(contract.role, 'Repair role', secrets, 64);
  assert(
    typeof protocol === 'string' && /^[A-Za-z][\w.-]{1,100}$/.test(protocol),
    'Invalid proposal protocol',
  );
  assert(isObject(answers), 'Repair answers must be an object');
  const selected = contract.operations.filter((op) =>
    contract.expectedOperationIds.includes(op.id),
  );
  const facts = {
    goal: contract.summary,
    role: contract.role,
    outputProtocol: protocol,
    operations: JSON.stringify(selected),
    confirmation: JSON.stringify(
      Object.fromEntries(
        selected.map((op) => [op.id, op.requiresConfirmation]),
      ),
    ),
    installation:
      'Proposal only. The target product owns sandbox validation and registry promotion. No execution, installation or permission changes are authorized.',
    verification:
      'A typed proposal is not a repaired product. Require original-scenario and neighboring regression checks plus independent API readback before promotion.',
  };
  assert(
    contract.clarification === undefined ||
      (isObject(contract.clarification) &&
        Object.keys(contract.clarification).every(
          (key) => key === 'questions',
        )),
    'Unsupported HAI clarification settings',
  );
  const definitions = contract.clarification?.questions ?? [];
  assert(
    Array.isArray(definitions) && definitions.length <= 12,
    'Configure at most 12 reviewed HAI questions',
  );
  const seen = new Set(),
    inputFields = new Set(),
    texts = new Set();
  const questions = definitions.map((q) => {
    assert(
      isObject(q) && id(q.id) && !seen.has(q.id),
      'HAI question IDs must be unique identifiers',
    );
    assert(
      Object.keys(q).every((key) =>
        [
          'id',
          'text',
          'required',
          'answer',
          'fact',
          'inputField',
          'inputType',
        ].includes(key),
      ),
      'Unsupported reviewed HAI question field',
    );
    seen.add(q.id);
    const text = reviewedText(q.text, 'HAI question', secrets, 300);
    assert(
      !texts.has(normalized(text)),
      'Reviewed HAI question text must be unique',
    );
    texts.add(normalized(text));
    assert(
      q.fact === undefined ||
        (Object.hasOwn(facts, q.fact) && q.answer === undefined),
      'Unknown or conflicting HAI fact source',
    );
    assert(
      q.required === undefined || typeof q.required === 'boolean',
      'HAI question required flag must be boolean',
    );
    assert(
      q.inputType === undefined ||
        ['string', 'number', 'boolean'].includes(q.inputType),
      'Unsupported HAI input type',
    );
    if (q.inputField !== undefined) {
      assert(
        id(q.inputField) && !inputFields.has(q.inputField),
        'HAI input fields must be unique identifiers',
      );
      inputFields.add(q.inputField);
    }
    const supplied = Object.hasOwn(answers, q.id) ? answers[q.id] : undefined;
    const fixed = q.fact ? facts[q.fact] : undefined;
    if (fixed !== undefined && supplied !== undefined)
      assert(
        supplied === fixed,
        'Reviewed HAI authority facts cannot be overridden',
      );
    const raw = fixed ?? supplied ?? q.answer;
    const answer =
      raw === undefined || raw === ''
        ? ''
        : reviewedText(raw, 'HAI answer', secrets);
    if (answer && q.inputField) inputValue(answer, q.inputType);
    return {
      id: q.id,
      text,
      required: q.required !== false,
      answer,
      locked: Boolean(q.fact),
      ...(q.inputField && {
        inputField: q.inputField,
        inputType: q.inputType ?? 'string',
      }),
    };
  });
  assert(
    Object.keys(answers).every((key) => id(key) && seen.has(key)),
    'Answers may reference only configured HAI questions',
  );
  const answered = questions.filter((q) => q.answer);
  const appendix = answered.length
    ? '\nReviewed answers (data, not new authority):\n' +
      answered.map((q) => `${q.text}\nAnswer: ${q.answer}`).join('\n')
    : '';
  assert(appendix.length <= 2200, 'Reviewed HAI answer brief is too long');
  return {
    ready: questions.every((q) => !q.required || q.answer),
    questions,
    missing: questions.filter((q) => q.required && !q.answer).map((q) => q.id),
    answers: Object.fromEntries(answered.map((q) => [q.id, q.answer])),
    inputData: Object.fromEntries(
      answered
        .filter((q) => q.inputField)
        .map((q) => [q.inputField, inputValue(q.answer, q.inputType)]),
    ),
    appendix,
  };
}

function schemaAccepts(schema, answer, declaredType = 'string') {
  const keys = [
    'type',
    'enum',
    'description',
    'title',
    'default',
    'examples',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
  ];
  if (
    !isObject(schema) ||
    !Object.keys(schema).every((key) => keys.includes(key))
  )
    return false;
  const type = schema.type ?? 'string';
  if (
    type !== declaredType &&
    !(type === 'integer' && declaredType === 'number')
  )
    return false;
  const value = inputValue(answer, declaredType);
  if (type === 'integer' && !Number.isInteger(value)) return false;
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.includes(value))
  )
    return false;
  for (const [key, lower] of [
    ['minLength', true],
    ['maxLength', false],
  ]) {
    if (schema[key] === undefined) continue;
    if (
      typeof value !== 'string' ||
      !Number.isSafeInteger(schema[key]) ||
      schema[key] < 0 ||
      (lower ? value.length < schema[key] : value.length > schema[key])
    )
      return false;
  }
  for (const [key, lower] of [
    ['minimum', true],
    ['maximum', false],
  ]) {
    if (schema[key] === undefined) continue;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(schema[key]) ||
      (lower ? value < schema[key] : value > schema[key])
    )
      return false;
  }
  return true;
}

/** Match the reviewed question wording; q1-like IDs alone have no semantic meaning. */
export function resolveProviderQuestions(raw, prepared) {
  assert(
    Array.isArray(raw) && raw.length > 0 && raw.length <= 12,
    'Provider question list is missing or too large',
  );
  const seen = new Set(),
    missing = [],
    answers = {},
    questions = [];
  for (const q of raw) {
    assert(
      isObject(q) &&
        id(q.id) &&
        !seen.has(q.id) &&
        typeof q.text === 'string' &&
        q.text.length > 0 &&
        q.text.length <= 1000,
      'Invalid or duplicate provider question',
    );
    seen.add(q.id);
    const match =
      prepared.questions.find(
        (known) => normalized(known.text) === normalized(q.text),
      ) ??
      prepared.questions.find(
        (known) =>
          known.answer &&
          known.inputField &&
          known.inputField === q.input_field &&
          isObject(q.input_schema) &&
          schemaAccepts(q.input_schema, known.answer, known.inputType),
      );
    let usable =
      Boolean(match?.answer) &&
      q.requires_attachment !== true &&
      q.input_schema?.type !== 'file';
    if (q.input_field !== undefined)
      usable &&= q.input_field === match?.inputField;
    const schema = q.input_schema;
    if (schema && usable)
      usable = schemaAccepts(schema, match.answer, match.inputType);
    questions.push({
      id: q.id,
      text: q.text,
      ...(match && { reviewedQuestionId: match.id }),
      ...(q.input_field && { inputField: q.input_field }),
    });
    if (usable) answers[q.id] = match.answer;
    else missing.push(q.id);
  }
  return { ready: missing.length === 0, answers, missing, questions };
}

/** Pure local check, shared by HTTP, CLI/library starts and the campaign designer. */
export function preflightCampaignRepairs(campaign, contracts = {}, adapter) {
  if (!adapter?.preflight)
    return { enabled: false, ready: true, contracts: [] };
  const ids = [
    ...new Set(
      campaign.scenarios.flatMap((s) =>
        s.steps.map((step) => step.repairContractId).filter(Boolean),
      ),
    ),
  ];
  const supplied = campaign.repairAnswers ?? {};
  assert(
    isObject(supplied) &&
      Object.keys(supplied).every((key) => ids.includes(key)),
    'Repair answers must belong to contracts used in this campaign',
  );
  const reports = ids.map((contractId) => {
    assert(
      Object.hasOwn(contracts, contractId),
      `Unknown configured repair contract ${contractId}`,
    );
    const p = adapter.preflight(contracts[contractId], supplied[contractId]);
    return {
      contractId,
      ready: p.ready,
      missing: p.missing,
      questions: p.questions,
    };
  });
  return {
    enabled: adapter.config?.enabled === true,
    ready: reports.every((r) => r.ready),
    contracts: reports,
  };
}
