/** Product adapters keep transport, credentials, fixture hooks and API observers outside model control. */
import {
  assert,
  at,
  bind,
  envHeaders,
  jsonRequest,
  safePath,
  sleep,
} from './util.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

function check(assertion, evidence, context) {
  const actual = at(evidence, assertion.path);
  const expected = bind(assertion.expected, context);
  switch (assertion.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return isDeepStrictEqual(actual, expected);
    case 'gte':
      return typeof actual === 'number' && actual >= expected;
    case 'includes':
      return (
        Array.isArray(actual) &&
        actual.some((item) => isDeepStrictEqual(item, expected))
      );
    case 'contains':
      return (
        typeof actual === 'string' &&
        typeof expected === 'string' &&
        actual.includes(expected)
      );
    case 'length':
      return Array.isArray(actual) && actual.length === expected;
    case 'unchanged':
      return (
        actual !== undefined &&
        at(context.beforeEvidence, assertion.path) !== undefined &&
        isDeepStrictEqual(actual, at(context.beforeEvidence, assertion.path))
      );
    default:
      throw new Error(`Unknown assertion ${assertion.op}`);
  }
}

export class HttpConversationAdapter {
  constructor(config, { env = process.env, fetchImpl } = {}) {
    assert(config?.baseUrl, 'Target needs a baseUrl');
    this.config = config;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.kind = config.type ?? 'http';
    this.identities = new Map();
  }
  manifest() {
    const describe = (hooks) =>
      Object.entries(hooks ?? {}).map(([id, hook]) => ({
        id,
        description: hook.description ?? id,
      }));
    return {
      worlds: Object.entries(this.config.bindings ?? {}).map(
        ([id, actors]) => ({
          id,
          actorIds: Object.entries(actors)
            .filter(([, actor]) => actor.qa === true)
            .map(([id]) => id),
        }),
      ),
      verifiers: describe(this.config.verifiers),
      fixtures: describe(this.config.fixtures),
      repairs: describe(this.config.repairContracts),
    };
  }
  isolationScopes(campaign) {
    const worlds = new Map();
    const origin = new URL(this.config.baseUrl).origin;
    for (const scenario of campaign.scenarios)
      for (const step of scenario.steps) {
        const binding = this.binding(scenario.worldId, step.actorId);
        const scope =
          binding.isolationKey ??
          binding.context?.familyId ??
          binding.context?.householdId;
        assert(
          ['string', 'number'].includes(typeof scope) &&
            String(scope).length > 0,
          'Live bindings need a familyId, householdId or explicit QA isolationKey',
        );
        const fingerprint = createHash('sha256')
          .update(`${origin}\0${scope}`)
          .digest('hex');
        assert(
          !worlds.has(scenario.worldId) ||
            worlds.get(scenario.worldId) === fingerprint,
          'Actors sharing a world must belong to the same QA scope',
        );
        worlds.set(scenario.worldId, fingerprint);
      }
    assert(
      new Set(worlds.values()).size === worlds.size,
      'Independent worlds cannot share a QA family; use the same worldId for an intentional shared story',
    );
    return [...worlds.values()];
  }
  binding(worldId, actorId) {
    const value = this.config.bindings?.[worldId]?.[actorId];
    assert(
      value?.qa === true && this.config.qaOnly === true,
      `No explicitly isolated QA binding for ${worldId}/${actorId}`,
    );
    return value;
  }
  context(input) {
    return {
      ...input,
      actor: this.binding(input.worldId, input.actor.id).context ?? {},
    };
  }
  assertStep(input) {
    this.binding(input.worldId, input.actor.id);
    const hook = this.config.verifiers?.[input.step.verifierId];
    if (input.step.verifierId || input.step.effect === 'write') {
      assert(
        hook && (hook.method ?? 'GET') === 'GET' && hook.assertions?.length,
        'Step needs an existing GET-only verifier with assertions',
      );
      for (const rule of hook.assertions) {
        assert(
          typeof rule.path === 'string' &&
            [
              'exists',
              'eq',
              'gte',
              'includes',
              'contains',
              'length',
              'unchanged',
            ].includes(rule.op),
          'Invalid observer assertion',
        );
        assert(
          ['exists', 'unchanged'].includes(rule.op) ||
            Object.hasOwn(rule, 'expected'),
          'Observer assertion needs an expected value',
        );
      }
    }
    if (input.step.kind === 'fixture')
      assert(
        this.config.allowFixtureWrites === true &&
          this.config.fixtures?.[input.step.fixtureId],
        'Fixture is not configured and enabled',
      );
  }
  async prepareStep(input, options) {
    this.assertStep(input);
    await this.guard(input, options?.signal);
    if (input.step.verifierId) {
      // Failed final-state predicates are normal before an action; an unavailable observer is not.
      const before = await this.verify(input, options);
      return before.evidence;
    }
  }
  async request(hook, context, headers, signal) {
    const path = safePath(hook.path, context);
    const url = new URL(path, this.config.baseUrl);
    assert(
      url.origin === new URL(this.config.baseUrl).origin,
      'Cross-origin target request refused',
    );
    return jsonRequest(url, {
      method: hook.method ?? 'GET',
      body: hook.body === undefined ? undefined : bind(hook.body, context),
      headers,
      signal,
      fetchImpl: this.fetchImpl,
      timeoutMs: hook.timeoutMs ?? this.config.timeoutMs ?? 180000,
    });
  }
  async guard(input, signal) {
    const binding = this.binding(input.worldId, input.actor.id);
    assert(
      this.config.identity?.path && this.config.identity.assertions?.length,
      'Live targets require a configured independent identity check',
    );
    const key = `${input.worldId}/${input.actor.id}`;
    if (!this.identities.has(key)) {
      const verified = (async () => {
        const context = this.context(input);
        const { data } = await this.request(
          { ...this.config.identity, method: 'GET', body: undefined },
          context,
          envHeaders(binding.headersEnv, this.env),
          signal,
        );
        assert(
          this.config.identity.assertions.every((rule) =>
            check(rule, data, context),
          ),
          'Authenticated QA identity differs from its binding',
        );
      })();
      this.identities.set(key, verified);
      try {
        await verified;
      } catch (error) {
        this.identities.delete(key);
        throw error;
      }
    } else await this.identities.get(key);
  }
  async send(input, { signal } = {}) {
    await this.guard(input, signal);
    const context = this.context(input);
    let hook = this.config.chat;
    if (this.kind === 'piggybank')
      hook = {
        path: '/api/ai/chat',
        method: 'POST',
        body: {
          message: '$message',
          familyId: '$actor.familyId',
          overrideMode: '$actor.mode',
          conversationHistory: '$history',
          loadStoredHistory: true,
          conversationId: '$conversationId',
          channel: 'web',
          inputMode: 'text',
          clientMessageId: '$messageId',
          languageCode: this.config.language ?? 'en',
          timezone: this.config.timezone ?? 'Asia/Dubai',
          ...(context.actor.childId ? { childId: '$actor.childId' } : {}),
        },
      };
    if (this.kind === 'basanti')
      hook = {
        path: '/api/trpc/staffConversation.ask',
        method: 'POST',
        body: {
          json: {
            householdId: '$actor.householdId',
            conversationId: '$conversationId',
            messageId: '$messageId',
            message: '$message',
            date: '$actor.date',
            timezone: '$actor.timezone',
          },
        },
      };
    assert(hook?.path, 'Target needs a chat mapping');
    const { data, status } = await this.request(
      { ...hook, method: 'POST' },
      context,
      envHeaders(
        this.binding(input.worldId, input.actor.id).headersEnv,
        this.env,
      ),
      signal,
    );
    const responsePaths =
      this.config.responsePaths ??
      (this.kind === 'piggybank'
        ? ['finalResponseText', 'response', 'message']
        : this.kind === 'basanti'
          ? [
              'result.data.json.reply.text',
              'result.data.json.response.text',
              'result.data.json.text',
            ]
          : ['response']);
    const text = responsePaths
      .map((path) => at(data, path))
      .find((value) => typeof value === 'string');
    assert(
      text !== undefined,
      'Target JSON did not contain a configured text response',
    );
    return {
      text,
      status,
      ...(this.config.tracePath
        ? { trace: at(data, this.config.tracePath) }
        : {}),
    };
  }
  async verify(input, { signal } = {}) {
    const hook = this.config.verifiers?.[input.step.verifierId];
    if (!hook)
      return {
        status: 'unavailable',
        reason: 'No independent API verifier is configured',
        checks: [],
      };
    assert(
      (hook.method ?? 'GET') === 'GET' && hook.assertions?.length,
      'Verifiers must be GET-only and declare assertions',
    );
    await this.guard(input, signal);
    const binding = this.binding(input.worldId, input.actor.id);
    const context = this.context(input);
    const { data } = await this.request(
      { ...hook, method: 'GET', body: undefined },
      context,
      envHeaders(binding.observerHeadersEnv ?? binding.headersEnv, this.env),
      signal,
    );
    const checks = hook.assertions.map((rule) => ({
      label: rule.label ?? `${rule.path} ${rule.op}`,
      passed: check(rule, data, context),
    }));
    return {
      status: checks.every((rule) => rule.passed) ? 'passed' : 'failed',
      checks,
      evidence: data,
    };
  }
  async fixture(input, { signal } = {}) {
    const hook = this.config.fixtures?.[input.step.fixtureId];
    assert(
      hook && this.config.allowFixtureWrites === true,
      'A reviewed QA fixture hook must be enabled explicitly',
    );
    await this.guard(input, signal);
    const binding = this.binding(input.worldId, input.actor.id);
    await this.request(
      hook,
      this.context(input),
      envHeaders(binding.fixtureHeadersEnv ?? binding.headersEnv, this.env),
      signal,
    );
    return {
      text: 'Configured QA fixture hook returned; independent verification follows.',
      status: 200,
    };
  }
}

/** A local world simulator makes the dashboard runnable without product credentials. */
export class DemoConversationAdapter {
  kind = 'demo';
  config = {};
  constructor({ delayMs = 450 } = {}) {
    this.delayMs = delayMs;
    this.worlds = new Map();
  }
  manifest() {
    return {
      verifiers: [
        { id: 'demoState', description: 'Simulated world state only' },
      ],
      fixtures: [
        { id: 'lessonHappens', description: 'Advance the simulated lesson' },
      ],
      repairs: [
        { id: 'demoGap', description: 'Seeded missing-capability repair' },
      ],
    };
  }
  async send(input, { signal } = {}) {
    await sleep(this.delayMs, signal);
    const state = this.worlds.get(input.worldId) ?? {
      lesson: null,
      scheduled: false,
      happened: false,
      feedback: null,
      turns: 0,
    };
    state.turns++;
    if (/add|create/i.test(input.step.id))
      state.lesson = {
        id: `demo-${input.worldId}`,
        title: 'Reading practice',
        child: 'Ari QA',
      };
    if (/schedule/i.test(input.step.id)) state.scheduled = true;
    if (/feedback/i.test(input.step.id) && input.actor.id !== 'child')
      state.feedback = 'Ari read clearly and should practise longer words.';
    this.worlds.set(input.worldId, state);
    const text =
      input.step.id === 'missingCapability'
        ? '[DEMO FAILURE] This reading progress capability is unavailable.'
        : input.actor.id === 'child'
          ? `Your teacher said: ${state.feedback ?? 'No feedback is recorded yet.'}`
          : `${input.actor.name}, the simulated ${input.step.id} step is recorded. ${state.lesson ? `Lesson: ${state.lesson.title}; child: ${state.lesson.child}.` : ''} ${state.scheduled ? 'Scheduled for the QA session.' : ''} ${state.happened ? 'Session completed.' : ''} ${state.feedback ?? ''}`;
    return { text, status: 200 };
  }
  async verify(input) {
    return {
      status: 'passed',
      checks: [{ label: 'Demo world only', passed: true }],
      evidence: structuredClone(this.worlds.get(input.worldId) ?? {}),
    };
  }
  async fixture(input, options) {
    await sleep(this.delayMs, options?.signal);
    const state = this.worlds.get(input.worldId);
    assert(state?.scheduled, 'Demo lesson must be scheduled first');
    state.happened = true;
    return {
      text: 'Demo lesson clock advanced. No real lesson, notification or payment occurred.',
      status: 200,
    };
  }
}

export function createAdapter(config, options) {
  return config.type === 'demo'
    ? new DemoConversationAdapter(config)
    : new HttpConversationAdapter(config, options);
}
