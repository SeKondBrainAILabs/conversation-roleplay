/** Actual adapter envelopes, independent authority and model JSON boundaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpConversationAdapter, JsonChatModel } from '../src/index.mjs';
import { bind, at, jsonRequest } from '../src/util.mjs';

const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });
const input = () => ({
  worldId: 'qaWorld',
  actor: { id: 'teacher' },
  step: { verifierId: 'saved' },
  message: 'Show my lesson',
  history: [],
  conversationId: '9223b7f2-87b9-4694-a687-b48c1ba22568',
  messageId: 'b12d5cfb-4896-4a55-85d6-79bdc569aa91',
  shared: {},
});
const binding = {
  qa: true,
  context: {
    id: 'qa-user',
    role: 'coach',
    familyId: 'qa-family',
    mode: 'kora_whatsapp_coach',
  },
  headersEnv: { Authorization: 'ACTOR_TOKEN' },
  observerHeadersEnv: { Authorization: 'OBSERVER_TOKEN' },
};
const base = {
  baseUrl: 'http://product.test',
  qaOnly: true,
  bindings: { qaWorld: { teacher: binding } },
  identity: {
    path: '/api/auth/me',
    assertions: [
      { path: 'data.id', op: 'eq', expected: '$actor.id' },
      { path: 'data.role', op: 'eq', expected: '$actor.role' },
      { path: 'data.familyId', op: 'eq', expected: '$actor.familyId' },
    ],
  },
};
const env = {
  ACTOR_TOKEN: 'qa-actor-credential',
  OBSERVER_TOKEN: 'qa-observer-credential',
};

test('Piggy adapter matches actor context and sends stable message IDs without observer authority', async () => {
  const calls = [];
  const adapter = new HttpConversationAdapter(
    { ...base, type: 'piggybank' },
    {
      env,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return calls.length === 1
          ? response({ data: binding.context })
          : response({ finalResponseText: 'Your reading lesson is tomorrow' });
      },
    },
  );
  const result = await adapter.send(input());
  const body = JSON.parse(calls[1].options.body);
  assert.equal(result.text, 'Your reading lesson is tomorrow');
  assert.equal(body.clientMessageId, input().messageId);
  assert.equal(body.familyId, 'qa-family');
  assert.equal(body.overrideMode, 'kora_whatsapp_coach');
  assert.equal(
    calls[1].options.headers.Authorization,
    'Bearer qa-actor-credential',
  );
  assert.equal(body.conversationId, input().conversationId);
  assert.equal(body.channel, 'web');
});

test('a wrong authenticated family prevents the target POST', async () => {
  const calls = [];
  const adapter = new HttpConversationAdapter(
    { ...base, type: 'piggybank' },
    {
      env,
      fetchImpl: async (url, options) => {
        calls.push(options.method);
        return response({ data: { ...binding.context, familyId: 'foreign' } });
      },
    },
  );
  await assert.rejects(adapter.send(input()), /identity differs/);
  assert.deepEqual(calls, ['GET']);
});

test('Basanti staff conversation uses the real strict date/timezone and tRPC JSON envelope', async () => {
  const calls = [];
  const context = {
    ...binding.context,
    householdId: 77,
    date: '2026-11-07',
    timezone: 'Asia/Dubai',
  };
  const adapter = new HttpConversationAdapter(
    {
      ...base,
      type: 'basanti',
      bindings: { qaWorld: { teacher: { ...binding, context } } },
    },
    {
      env,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return calls.length === 1
          ? response({ data: context })
          : response({
              result: {
                data: {
                  json: {
                    turnId: 42,
                    reply: {
                      text: 'Your assigned reading task',
                      kind: 'answer',
                    },
                  },
                },
              },
            });
      },
    },
  );
  assert.equal(
    (await adapter.send(input())).text,
    'Your assigned reading task',
  );
  assert.ok(calls[1].url.endsWith('/api/trpc/staffConversation.ask'));
  assert.deepEqual(JSON.parse(calls[1].options.body).json, {
    householdId: 77,
    conversationId: input().conversationId,
    messageId: input().messageId,
    message: 'Show my lesson',
    date: '2026-11-07',
    timezone: 'Asia/Dubai',
  });
});

test('independent GET-only observers use observer credentials and cannot overrule mismatched saved data', async () => {
  const calls = [];
  const adapter = new HttpConversationAdapter(
    {
      ...base,
      type: 'http',
      verifiers: {
        saved: {
          path: '/api/tasks',
          assertions: [
            {
              label: 'Correct child',
              path: 'saved.childId',
              op: 'eq',
              expected: 'nora-qa',
            },
          ],
        },
      },
    },
    {
      env,
      fetchImpl: async (url, options) => {
        calls.push(options);
        return calls.length === 1
          ? response({ data: binding.context })
          : response({ saved: { childId: 'milo-qa' } });
      },
    },
  );
  const result = await adapter.verify(input());
  assert.equal(result.status, 'failed');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].headers.Authorization, 'Bearer qa-observer-credential');
  adapter.config.verifiers.saved.method = 'POST';
  await assert.rejects(adapter.verify(input()), /GET-only/);
});

test('generic adapter supports typed mappings, scoped paths, and explicit response extraction', async () => {
  const calls = [];
  const adapter = new HttpConversationAdapter(
    {
      ...base,
      type: 'http',
      chat: {
        path: '/api/family/{actor.familyId}/conversation',
        body: { text: '$message', id: '$messageId', context: '$shared' },
      },
      responsePaths: ['reply.text'],
    },
    {
      env,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return calls.length === 1
          ? response({ data: binding.context })
          : response({ reply: { text: 'Mapped answer' } });
      },
    },
  );
  assert.equal((await adapter.send(input())).text, 'Mapped answer');
  assert.ok(calls[1].url.endsWith('/api/family/qa-family/conversation'));
  assert.deepEqual(JSON.parse(calls[1].options.body).context, {});
});

test('missing QA binding, unsafe JSON paths, unbound fields and redirects fail closed', async () => {
  const adapter = new HttpConversationAdapter({
    ...base,
    type: 'piggybank',
    qaOnly: false,
  });
  await assert.rejects(adapter.send(input()), /QA binding/);
  assert.throws(() => at({}, '__proto__.x'), /Unsafe/);
  assert.throws(() => bind('$missing', {}), /Unbound/);
  let calls = 0;
  await assert.rejects(
    jsonRequest('http://target.test', {
      method: 'POST',
      fetchImpl: async (_, options) => {
        calls++;
        assert.equal(options.redirect, 'error');
        throw new Error('redirect');
      },
    }),
    (error) => error.outcomeUnknown === true,
  );
  assert.equal(calls, 1);
});

test('independent scenario worlds cannot secretly share a live family', () => {
  const adapter = new HttpConversationAdapter({
    ...base,
    bindings: {
      qaWorld: { teacher: binding },
      anotherWorld: { teacher: binding },
    },
  });
  const scenarios = [
    { worldId: 'qaWorld', steps: [{ actorId: 'teacher' }] },
    { worldId: 'anotherWorld', steps: [{ actorId: 'teacher' }] },
  ];
  assert.throws(
    () => adapter.isolationScopes({ scenarios }),
    /cannot share a QA family/,
  );
  adapter.config.bindings.anotherWorld.teacher = {
    ...binding,
    context: { ...binding.context, familyId: 'another-qa-family' },
  };
  assert.equal(adapter.isolationScopes({ scenarios }).length, 2);
});

test('unknown verifier cannot authorize a write and a failing observer prevents preparation', async () => {
  let calls = 0;
  const adapter = new HttpConversationAdapter(
    { ...base, type: 'piggybank' },
    {
      env,
      fetchImpl: async () => {
        calls++;
        return response({ data: binding.context });
      },
    },
  );
  const write = {
    ...input(),
    step: { effect: 'write', verifierId: 'invented' },
  };
  await assert.rejects(
    adapter.prepareStep(write),
    /existing GET-only verifier/,
  );
  assert.equal(calls, 0);
  adapter.config.verifiers = {
    invented: {
      path: '/api/observer',
      assertions: [{ path: 'saved', op: 'exists' }],
    },
  };
  adapter.fetchImpl = async () =>
    ++calls === 1
      ? response({ data: binding.context })
      : response({ error: 'down' }, 503);
  await assert.rejects(adapter.prepareStep(write), /HTTP 503/);
  assert.equal(calls, 2);
});

test('unchanged observer fields compare against the pre-action evidence', async () => {
  let calls = 0;
  const adapter = new HttpConversationAdapter(
    {
      ...base,
      type: 'http',
      verifiers: {
        saved: {
          path: '/api/state',
          assertions: [{ path: 'wallet', op: 'unchanged' }],
        },
      },
    },
    {
      env,
      fetchImpl: async () =>
        ++calls === 1
          ? response({ data: binding.context })
          : response({ wallet: 17 }),
    },
  );
  assert.equal(
    (await adapter.verify({ ...input(), beforeEvidence: { wallet: 17 } }))
      .status,
    'passed',
  );
  assert.equal(
    (await adapter.verify({ ...input(), beforeEvidence: { wallet: 20 } }))
      .status,
    'failed',
  );
});

test('LLM JSON is parsed as data, invalid JSON cannot become an actor action, and judge is separately prompted', async () => {
  const calls = [];
  const model = new JsonChatModel(
    {
      url: 'http://model.test/v1/chat/completions',
      model: 'test-model',
      headersEnv: { Authorization: 'MODEL_TOKEN' },
    },
    {
      env: { MODEL_TOKEN: 'model-credential' },
      fetchImpl: async (_, options) => {
        calls.push(JSON.parse(options.body));
        return response({
          choices: [
            {
              message: {
                content: '```json\n{"verdict":"pass","goalComplete":true}\n```',
              },
            },
          ],
        });
      },
    },
  );
  assert.equal(
    (await model.complete('judge', { goal: 'Read assigned task' })).verdict,
    'pass',
  );
  assert.match(calls[0].messages[0].content, /untrusted data/);
  assert.equal(calls[0].temperature, 0);
  const bad = new JsonChatModel(
    { url: 'http://model.test', model: 'test' },
    {
      fetchImpl: async () =>
        response({ choices: [{ message: { content: 'Run arbitrary code' } }] }),
    },
  );
  await assert.rejects(bad.complete('actor', {}), /valid JSON/);
});
