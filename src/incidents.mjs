/** Kora One owns the capability map and durable HAI queue. This client never repairs product code. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assert, isObject, jsonRequest, now } from './util.mjs';

const ids = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/.test(value);
const types = new Set([
  'unmapped_case',
  'unavailable_skill',
  'api_contract_missing',
  'api_execution_failed',
  'schema_invalid',
  'adapter_failed',
  'eval_failed',
]);
export function validateIncidentContract(value) {
  assert(
    isObject(value) && ['piggybank', 'basanti'].includes(value.product),
    'Incident needs a configured product',
  );
  assert(
    Object.keys(value).every((key) =>
      [
        'product',
        'platformRole',
        'roleIds',
        'incidentType',
        'reasonCode',
        'caseId',
        'skillId',
        'apiId',
      ].includes(key),
    ),
    'Unsupported incident authority or context',
  );
  assert(
    ids(value.platformRole) &&
      Array.isArray(value.roleIds) &&
      value.roleIds.length > 0 &&
      value.roleIds.length <= 10 &&
      value.roleIds.every(ids),
    'Incident needs configured platform and registry roles',
  );
  assert(
    types.has(value.incidentType) &&
      ids(value.reasonCode) &&
      value.reasonCode.length <= 96,
    'Invalid incident classification',
  );
  for (const key of ['caseId', 'skillId', 'apiId'])
    assert(
      value[key] === undefined || ids(value[key]),
      'Invalid capability map reference',
    );
  return value;
}

export function incidentEligible(step) {
  return (
    step.status === 'failed' &&
    !step.error &&
    !step.errorSource &&
    ((step.verification?.status === 'failed' &&
      step.verification.checks?.some((item) => item.passed === false)) ||
      (step.judgment?.verdict === 'fail' &&
        [
          'missing_capability',
          'effect_mismatch',
          'context_loss',
          'unsupported_claim',
          'provider_unavailable',
        ].includes(step.judgment.category))) &&
    step.judgment?.category !== 'policy_denial' &&
    !step.instructionResults?.some((item) => item.status === 'invalid_request')
  );
}

export function capabilityIncident(input) {
  const contract = validateIncidentContract(input.contract);
  assert(
    input.product === contract.product &&
      input.platformRole === contract.platformRole,
    'Incident binding differs from authenticated platform role/product',
  );
  assert(
    incidentEligible(input.step),
    'Only an evaluated product failure may become a HAI incident',
  );
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([input.runId, input.scenarioId, input.step.id, contract]),
    )
    .digest('hex');
  return {
    fingerprint,
    body: {
      source_product: contract.product,
      role_ids: [...contract.roleIds],
      incident_type: contract.incidentType,
      reason_code: contract.reasonCode,
      ...(contract.caseId && { case_id: contract.caseId }),
      ...(contract.skillId && { skill_id: contract.skillId }),
      ...(contract.apiId && { api_id: contract.apiId }),
      trace_id: `roleplay.${fingerprint}`,
      safe_context: {
        adapter: 'conversation-roleplay',
        component: 'conversation_evaluation',
        schema_version: '1',
        completion_state: 'failed',
        environment: 'test',
        eval_id: `roleplay.${fingerprint}`,
        error_class:
          input.step.verification?.status === 'failed'
            ? 'effect_mismatch'
            : input.step.judgment.category,
      },
    },
  };
}

export function preflightIncidentContracts(campaign, adapter, client) {
  for (const scenario of campaign.scenarios)
    for (const step of scenario.steps) {
      if (!step.incidentContractId) continue;
      const contract = validateIncidentContract(
        adapter.config?.incidentContracts?.[step.incidentContractId],
      );
      assert(
        adapter.kind !== 'demo' &&
          client?.config?.enabled === true &&
          client.config.contractVerified === true,
        'HAI-led campaigns need the reviewed Kora One incident service enabled',
      );
      assert(
        contract.product === campaign.target &&
          contract.platformRole ===
            adapter.binding(scenario.worldId, step.actorId).context?.role,
        'Incident contract does not match the bound platform actor',
      );
    }
}

export class KoraOneIncidentClient {
  constructor(config, coreBackend, { fetchImpl, getHeaders } = {}) {
    this.config = config;
    this.coreBackend = coreBackend;
    this.fetchImpl = fetchImpl;
    this.getHeaders = getHeaders;
    this.attempts = new Map();
  }
  report(input) {
    if (!this.config?.enabled)
      return Promise.resolve({ status: 'disabled', effectVerified: false });
    if (!incidentEligible(input.step))
      return Promise.resolve({ status: 'not_eligible', effectVerified: false });
    const prepared = capabilityIncident(input);
    const previous = input.step.incident;
    if (
      [
        'submitting',
        'submission_unknown',
        'submission_rejected',
        'incident_recorded',
      ].includes(previous?.status)
    ) {
      assert(
        previous.fingerprint === prepared.fingerprint,
        'Review the existing incident before changing its repair contract',
      );
      return Promise.resolve(structuredClone(previous));
    }
    if (!this.attempts.has(prepared.fingerprint))
      this.attempts.set(prepared.fingerprint, this.submit(input, prepared));
    return this.attempts.get(prepared.fingerprint).then(structuredClone);
  }
  async transport(signal) {
    assert(
      this.config.contractVerified === true &&
        this.coreBackend &&
        this.getHeaders,
      'Review the Kora One contract and configure canonical service identity',
    );
    const origin = new URL(this.config.baseUrl);
    assert(
      ['http:', 'https:'].includes(origin.protocol) &&
        !origin.username &&
        !origin.password &&
        !origin.search &&
        !origin.hash &&
        origin.pathname === '/',
      'Kora One needs an operator-configured HTTP origin',
    );
    const identity = await this.coreBackend.identity({ signal });
    assert(
      typeof identity.orgId === 'string' && identity.orgId,
      'Canonical Core organization is required',
    );
    return {
      origin,
      identity,
      headers: {
        ...(await this.getHeaders(signal)),
        'X-Organization-Id': identity.orgId,
      },
    };
  }
  async check() {
    const { origin, headers } = await this.transport();
    const product = this.config.probeProduct;
    assert(
      ['piggybank', 'basanti'].includes(product),
      'Configure the Kora One probe product',
    );
    const { data } = await jsonRequest(
      new URL(`/api/internal/capabilities/catalog?product=${product}`, origin),
      { headers, fetchImpl: this.fetchImpl, timeoutMs: 15000 },
    );
    assert(
      data.product === product &&
        typeof data.version === 'string' &&
        /^[a-f0-9]{64}$/.test(data.digest) &&
        Array.isArray(data.cases) &&
        Array.isArray(data.roles),
      'Kora One catalog does not match the reviewed contract',
    );
    return {
      reachable: true,
      catalogVersion: data.version,
      catalogDigest: data.digest,
      repairVerified: false,
    };
  }
  async reconcile(input, receipt) {
    const prepared = capabilityIncident(input);
    assert(
      receipt.fingerprint === prepared.fingerprint,
      'Incident reconciliation fingerprint mismatch',
    );
    const { origin, headers, identity } = await this.transport(input.signal);
    const { data } = await jsonRequest(
      new URL(
        `/api/internal/capabilities/incidents?status=all&product=${prepared.body.source_product}&limit=100`,
        origin,
      ),
      {
        headers,
        signal: input.signal,
        fetchImpl: this.fetchImpl,
        timeoutMs: 15000,
      },
    );
    assert(Array.isArray(data.incidents), 'Invalid incident readback');
    const matches = data.incidents.filter(
      (item) => item.trace_id === prepared.body.trace_id,
    );
    let result;
    if (
      matches.length !== 1 ||
      !this.correlated(matches[0], prepared, identity)
    )
      result = {
        ...receipt,
        status: 'submission_unknown',
        effectVerified: false,
        reason:
          'No unique correlated receipt in the bounded readback. Keep quarantine; do not resubmit.',
      };
    else
      result = {
        ...receipt,
        status: 'incident_recorded',
        incidentId: matches[0].incident_id,
        haiDeliveryStatus: matches[0].hai_delivery_status,
        registryVersion: matches[0].registry_version,
        registryDigest: matches[0].registry_digest,
        effectVerified: false,
        reason:
          'Correlated by GET only. No product effect or HAI repair is established.',
      };
    await input.checkpoint(structuredClone(result));
    return result;
  }
  correlated(incident, prepared, identity) {
    return (
      /^capinc_[a-f0-9]{32}$/.test(incident?.incident_id) &&
      incident.org_id === identity.orgId &&
      incident.trace_id === prepared.body.trace_id &&
      incident.source_product === prepared.body.source_product &&
      JSON.stringify(incident.role_ids) ===
        JSON.stringify(prepared.body.role_ids) &&
      incident.case_id === (prepared.body.case_id ?? null) &&
      incident.skill_id === (prepared.body.skill_id ?? null) &&
      incident.api_id === (prepared.body.api_id ?? null) &&
      isDeepStrictEqual(incident.safe_context, prepared.body.safe_context) &&
      incident.reason_code === prepared.body.reason_code &&
      incident.incident_type === prepared.body.incident_type &&
      typeof incident.registry_version === 'string' &&
      /^[a-f0-9]{64}$/.test(incident.registry_digest)
    );
  }
  async submit(input, prepared) {
    const { origin, headers, identity } = await this.transport(input.signal);
    const receipt = {
      status: 'submitting',
      fingerprint: prepared.fingerprint,
      attempts: 1,
      at: now(),
      repairLead: 'hai',
      effectVerified: false,
    };
    await input.checkpoint(structuredClone(receipt));
    try {
      const { status, data } = await jsonRequest(
        new URL('/api/internal/capabilities/incidents', origin),
        {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': prepared.fingerprint },
          body: prepared.body,
          signal: input.signal,
          fetchImpl: this.fetchImpl,
          timeoutMs: 15000,
        },
      );
      const incident = data.incident;
      assert(
        status === 202 && this.correlated(incident, prepared, identity),
        'Uncorrelated Kora One incident receipt',
      );
      Object.assign(receipt, {
        status: 'incident_recorded',
        incidentId: incident.incident_id,
        haiDeliveryStatus: incident.hai_delivery_status,
        registryVersion: incident.registry_version,
        registryDigest: incident.registry_digest,
        reason:
          'Recorded for HAI. Queue delivery, a proposed patch or incident resolution does not establish a repaired product.',
      });
    } catch (error) {
      receipt.status =
        error.status >= 400 && error.status < 500
          ? 'submission_rejected'
          : 'submission_unknown';
      receipt.reason =
        'Inspect the correlated Kora One incident; never repeat an uncertain submission or product action.';
    }
    await input.checkpoint(structuredClone(receipt));
    return receipt;
  }
}
