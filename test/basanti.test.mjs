import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpConversationAdapter, CampaignRun, JsonChatModel } from '../src/index.mjs';
import { renderBasantiReply, matchesLocalDateTime } from '../src/basanti.mjs';

const actor = { id: 'cook', name: 'Cook QA', description: 'Synthetic household cook', persona: { style: 'Concise' } };
const context = { userId: 3, householdId: 1, date: '2026-11-16', timezone: 'Asia/Dubai' };
const expected = { date: '2026-11-17', time: '19:00:00', timezone: 'Asia/Dubai' };
const step = { id: 'review', actorId: actor.id, goal: 'Review tomorrow dinner at 7pm', effect: 'read', verifierId: 'meal', maxTurns: 1 };
const input = { worldId: 'house', actor, step, conversationId: 'a', messageId: 'b', message: step.goal, history: [], shared: {} };
function fixture({ savedDate = '2026-11-17T15:00:00.000Z', clock = context, assertions, reply, config = {} } = {}) {
  const calls = [];
  const nativeReply = reply ?? { text: 'Recorded tasks', date: context.date, timezone: context.timezone, tasks: [{ id: 1, title: 'Soak chickpeas', dueDate: '2026-11-16T13:00:00Z' }], translations: [] };
  const envelope = { result: { data: { json: { turnId: 7, reply: nativeReply } } } };
  const adapter = new HttpConversationAdapter({
    type: 'basanti', baseUrl: 'http://fixture.invalid', qaOnly: true,
    bindings: { house: { cook: { qa: true, context: clock, headersEnv: { Cookie: 'COOKIE' } } } },
    identity: { path: '/identity', assertions: [{ path: 'userId', op: 'eq', expected: '$actor.userId' }] },
    verifiers: { meal: { path: '/observed', assertions: assertions ?? [
      { path: 'meals', op: 'length', expected: 1 },
      { path: 'meals', op: 'matches', expected: { id: 9, householdId: 1, ownerId: 3, state: 'pending' }, count: 1 },
      { path: 'meals.0.date', op: 'localDateTime', expected },
    ] } }, ...config,
  }, { env: { COOKIE: 'synthetic-only' }, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(String(url).endsWith('/identity') ? clock : options.method === 'POST' ? envelope :
      { meals: [{ id: 9, householdId: 1, ownerId: 3, state: 'pending', date: savedDate }] }), { status: 200 });
  } });
  return { adapter, calls, envelope };
}

test('Basanti actor sees actual shared-channel cards/translations/candidates and full native evidence', async () => {
  const { adapter, calls, envelope } = fixture({ reply: {
    text: 'Review before saving', date: context.date, timezone: context.timezone, tasks: [{ id: 1, title: 'Soak chickpeas' }, { id: 2, title: 'Prepare dinner', instructions: 'Not rendered by shared channel' }],
    translations: [{ taskId: 1, title: 'चना भिगोएँ', instructions: 'आठ घंटे' }],
    candidates: [{ displayName: 'Cook QA', sourceRole: 'cook', whatsappVerified: true }],
    proposedAction: { kind: 'meal', requestedDate: '2026-11-17T15:00:00Z' },
  } });
  const result = await adapter.send(input);
  assert.equal(result.text, 'Review before saving\n1: चना भिगोएँ — आठ घंटे\n2: Prepare dinner\nCook QA · cook · WhatsApp verified');
  assert.deepEqual(result.trace, envelope);
  assert.deepEqual(result.requestContext, { date: context.date, timezone: context.timezone, householdId: 1 });
  assert.equal(result.surface, 'basanti-shared-channel');
  assert.deepEqual(result.productContext, { date: context.date, timezone: context.timezone });
  assert.equal(result.clockVerification.status, 'passed');
  const sent = JSON.parse(calls.at(-1).options.body).json;
  assert.equal(sent.date, '2026-11-16');
  assert.equal(sent.timezone, 'Asia/Dubai');
  assert.equal(result.text.includes('requestedDate'), false);
});

test('shared-channel limit matches production and never synthesizes missing cards', () => {
  assert.equal(renderBasantiReply({ text: 'x'.repeat(4100), tasks: [], translations: [] }).length, 4000);
  assert.equal(renderBasantiReply({ text: 'Need your photo', tasks: [], translations: [] }), 'Need your photo');
  assert.throws(() => renderBasantiReply({ text: 'ok', tasks: [{ id: 1 }] }), /structured reply/);
  assert.throws(() => renderBasantiReply({ text: 'ok', candidates: [{ displayName: 'QA', sourceRole: 'cook', whatsappVerified: 'false' }] }), /structured reply/);
});

test('custom response/trace extraction remains explicit and retains fixture clock', async () => {
  const { adapter } = fixture({ config: { responsePaths: ['result.data.json.reply.text'], tracePath: 'result.data.json.reply' } });
  const result = await adapter.send(input);
  assert.equal(result.text, 'Recorded tasks');
  assert.equal(result.surface, 'custom-response-paths');
  assert.equal(result.trace.tasks[0].id, 1);
  assert.equal(result.requestContext.date, '2026-11-16');
});

test('fixture dates and IANA zones are rejected before identity or product traffic', async () => {
  for (const clock of [
    { ...context, date: undefined }, { ...context, date: '2026-02-30' },
    { ...context, date: '2026-11-16T00:00:00Z' }, { ...context, timezone: 'Mars/Olympus' },
    { ...context, timezone: '' },
  ]) {
    const { adapter, calls } = fixture({ clock });
    assert.throws(() => adapter.assertStep(input));
    await assert.rejects(adapter.send(input));
    assert.equal(calls.length, 0);
  }
});

test('exact household timestamps reject wrong day, wrong time and naive or normalized dates', () => {
  assert.equal(matchesLocalDateTime('2026-11-17T15:00:00Z', expected), true);
  assert.equal(matchesLocalDateTime('2026-11-17T19:00:00+04:00', expected), true);
  for (const value of ['2026-11-16T15:00:00Z', '2026-11-17T00:00:00Z',
    '2026-11-17T19:00:00', '2026-11-17', '2026-11-17T15:00:00.001Z',
    '2026-11-17T24:00:00Z', '2026-11-17T15:60:00Z', null, 1794927600000])
    assert.equal(matchesLocalDateTime(value, expected), false, String(value));
  assert.equal(matchesLocalDateTime('2026-02-30T15:00:00Z', { ...expected, date: '2026-03-02' }), false);
});

test('local timestamp projection handles midnight rollover, fractional offsets and DST without runner-clock dependence', () => {
  for (const [instant, date, time, timezone] of [
    ['2026-11-16T20:30:00Z', '2026-11-17', '00:30:00', 'Asia/Dubai'],
    ['2026-11-16T13:15:00Z', '2026-11-16', '19:00:00', 'Asia/Kathmandu'],
    ['2026-03-08T06:30:00Z', '2026-03-08', '01:30:00', 'America/New_York'],
    ['2026-03-08T07:30:00Z', '2026-03-08', '03:30:00', 'America/New_York'],
    ['2026-11-01T05:30:00Z', '2026-11-01', '01:30:00', 'America/New_York'],
    ['2026-11-01T06:30:00Z', '2026-11-01', '01:30:00', 'America/New_York'],
  ]) assert.equal(matchesLocalDateTime(instant, { date, time, timezone }), true);
  assert.equal(matchesLocalDateTime('2026-03-08T07:30:00Z', { date: '2026-03-08', time: '02:30:00', timezone: 'America/New_York' }), false);
});

test('malformed exact-time observer contracts fail preflight before any model or API call', () => {
  for (const invalid of [{ ...expected, date: '2026-02-30' }, { ...expected, time: '7pm' },
    { ...expected, time: '24:00:00' }, { ...expected, timezone: 'Invalid/Timezone' }]) {
    const { adapter, calls } = fixture({ assertions: [{ path: 'date', op: 'localDateTime', expected: invalid }] });
    assert.throws(() => adapter.assertStep(input));
    assert.equal(calls.length, 0);
  }
});

test('exact local date failure overrides fluent semantic pass and blocks dependent work', async () => {
  const { adapter } = fixture({ savedDate: '2026-11-16T15:00:00Z' });
  const model = { kind: 'test', complete: async purpose => purpose === 'actor'
    ? { message: 'Please show tomorrow dinner at 7pm', done: false, reason: 'Request the reviewed goal' }
    : { verdict: 'pass', goalComplete: true, category: 'none', reason: 'Deliberately incorrect semantic pass', evidence: [] } };
  const run = new CampaignRun({ version: 1, name: 'Temporal regression', target: 'basanti', roles: [actor],
    scenarios: [{ id: 'dinner', title: 'Dinner', worldId: 'house', steps: [step,
      { ...step, id: 'dependent', dependsOn: ['review'] }] }],
  }, { adapter, actorModel: model });
  const result = await run.start();
  assert.ok(result.steps[0].judgment, result.error ?? JSON.stringify(result.steps[0]));
  assert.equal(result.steps[0].judgment.verdict, 'pass');
  assert.equal(result.steps[0].verification.status, 'failed');
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[1].status, 'blocked');
  assert.equal(result.qualified, false);
});

test('contradictory or missing native household clock is an unverified test setup, never a product date failure', async () => {
  for (const nativeClock of [
    { date: '2026-11-17', timezone: 'Asia/Dubai' },
    { date: context.date, timezone: 'America/New_York' }, {},
  ]) {
    const { adapter, calls } = fixture({ reply: { text: 'Native reply', tasks: [], translations: [], ...nativeClock } });
    let judgeCalls = 0;
    const model = { kind: 'test', complete: async purpose => {
      if (purpose === 'judge') { judgeCalls++; throw new Error('Clock mismatch must precede model judgment'); }
      return { message: 'Please show tomorrow dinner', done: false };
    } };
    const run = new CampaignRun({ version: 1, name: 'Clock qualification', target: 'basanti', roles: [actor],
      scenarios: [{ id: 'dinner', title: 'Dinner', worldId: 'house', steps: [{ ...step, maxTurns: 3 },
        { ...step, id: 'dependent', dependsOn: ['review'] }] }],
    }, { adapter, actorModel: model });
    const result = await run.start();
    assert.equal(result.steps[0].status, 'unverified');
    assert.equal(result.steps[0].errorSource, 'test_setup');
    assert.equal(result.steps[0].judgment.source, 'fixture-clock-check');
    assert.equal(result.steps[0].verification.status, 'passed');
    assert.equal(result.steps[0].transcript.length, 2);
    assert.equal(result.steps[1].status, 'blocked');
    assert.equal(judgeCalls, 0);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    assert.equal(result.qualified, false);
    assert.equal(result.steps[0].repair, undefined);
    assert.equal(result.steps[0].incident, undefined);
  }
});

test('verified semantic and saved-state success ends without a redundant actor call or product replay', async () => {
  const { adapter, calls } = fixture();
  let actorCalls = 0;
  const model = { kind: 'test', complete: async purpose => {
    if (purpose === 'actor') {
      actorCalls++;
      if (actorCalls > 1) throw new Error('A redundant finishing call returned invalid JSON');
      return { message: 'Please show the reviewed dinner', done: false };
    }
    return { verdict: 'pass', goalComplete: true, category: 'none', reason: 'Goal and independent state agree', evidence: [] };
  } };
  const run = new CampaignRun({ version: 1, name: 'Settled outcome', target: 'basanti', roles: [actor],
    scenarios: [{ id: 'dinner', title: 'Dinner', worldId: 'house', steps: [{ ...step, effect: 'write', maxTurns: 4 }] }],
  }, { adapter, actorModel: model });
  const result = await run.start();
  assert.equal(result.steps[0].status, 'passed');
  assert.equal(result.steps[0].verification.status, 'passed');
  assert.equal(result.steps[0].transcript.length, 2);
  assert.equal(actorCalls, 1);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(result.modelCalls, 2);
});

test('fluent success cannot stop necessary follow-up when the required observer fails or is unavailable', async () => {
  for (const observerStatus of ['failed', 'unavailable']) {
    const { adapter, calls } = fixture({ savedDate: '2026-11-16T15:00:00Z' });
    if (observerStatus === 'unavailable') adapter.verify = async () => ({ status: 'unavailable', checks: [] });
    let actorCalls = 0;
    const model = { kind: 'test', complete: async purpose => {
      if (purpose === 'actor') {
        actorCalls++;
        assert.ok(actorCalls <= 2, 'Turn limit must not trigger an extra finishing call');
        return { message: 'Check the dinner date again without creating another dinner', done: false };
      }
      return { verdict: 'pass', goalComplete: true, category: 'none', reason: 'Unreliable semantic opinion', evidence: [] };
    } };
    const run = new CampaignRun({ version: 1, name: 'Required observer', target: 'basanti', roles: [actor],
      scenarios: [{ id: 'dinner', title: 'Dinner', worldId: 'house', steps: [{ ...step, maxTurns: 2 }] }],
    }, { adapter, actorModel: model });
    const result = await run.start();
    assert.equal(result.steps[0].status, observerStatus === 'failed' ? 'failed' : 'unverified');
    assert.equal(actorCalls, 2);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 2);
    assert.equal(result.qualified, false);
  }
});

test('actual actor transport grounds approval in the human role and keeps review-only scope', async () => {
  const model = new JsonChatModel({ url: 'https://model.example', model: 'test' });
  const request = await model.transport('actor', {});
  const system = request.body.messages[0].content;
  assert.match(system, /human account holder/);
  assert.match(system, /do not ask whether you should execute/);
  assert.match(system, /review-only goal ends/);
  const judge = await model.transport('judge', {});
  assert.match(judge.body.messages[0].content, /pending proposal with no saved changes is complete/);
  assert.match(judge.body.messages[0].content, /Do not invent extra required fields/);
});
