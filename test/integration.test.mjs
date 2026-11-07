/** End-to-end local protocol fixture: real HTTP model/target traffic, shared state, and cross-role handoffs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  CampaignRun,
  HttpConversationAdapter,
  JsonChatModel,
} from '../src/index.mjs';

test('HTTP model actor loops complete a five-stage lifecycle with independent observers and a fixture event', async (t) => {
  const state = {
    created: false,
    scheduled: false,
    happened: false,
    feedback: null,
  };
  const operations = [],
    modelPurposes = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    const send = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/model') {
      const prompt = body.messages[0].content;
      const input = JSON.parse(body.messages[1].content);
      let answer;
      if (prompt.startsWith('Expand')) {
        modelPurposes.push('enhance');
        answer = {
          roles: input.roles.map((role) => ({
            ...role,
            persona: { style: 'Realistic test fixture' },
          })),
        };
      } else if (prompt.startsWith('You are a synthetic')) {
        modelPurposes.push('actor');
        answer = input.transcript.length
          ? { message: '', done: true, reason: 'Check evidence' }
          : {
              message: input.step.goal,
              done: false,
              reason: 'Pursue assigned goal',
            };
      } else {
        modelPurposes.push('judge');
        answer = {
          verdict: 'pass',
          goalComplete: input.verification.status === 'passed',
          category: 'none',
          reason: 'Local protocol fixture oracle',
          evidence: ['observer'],
        };
      }
      return send({
        choices: [{ message: { content: JSON.stringify(answer) } }],
      });
    }
    if (req.url === '/api/me')
      return send({ id: req.headers['x-actor'], family: 'fixture-family' });
    if (req.url === '/api/state') return send(state);
    if (req.url === '/api/fixture') {
      assert.equal(state.scheduled, true);
      state.happened = true;
      operations.push('happens');
      return send({ done: true });
    }
    if (req.url === '/api/chat') {
      operations.push(body.stage);
      if (body.stage === 'create') state.created = true;
      if (body.stage === 'schedule') {
        assert.equal(state.created, true);
        state.scheduled = true;
      }
      if (body.stage === 'feedback') {
        assert.equal(state.happened, true);
        state.feedback = 'Great progress';
      }
      if (body.stage === 'summary')
        assert.equal(state.feedback, 'Great progress');
      return send({
        answer:
          body.stage === 'summary' ? state.feedback : `Recorded ${body.stage}`,
      });
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const roles = ['parent', 'teacher', 'child'].map((id) => ({
    id,
    name: id,
    description: 'Fictional local protocol fixture role',
  }));
  const bindings = Object.fromEntries(
    roles.map((role) => [
      role.id,
      {
        qa: true,
        context: { id: role.id },
        headersEnv: { 'x-actor': role.id.toUpperCase() },
      },
    ]),
  );
  const checks = (field) => ({
    path: '/api/state',
    assertions: [
      {
        path: field,
        op: 'eq',
        expected: field === 'feedback' ? 'Great progress' : true,
      },
    ],
  });
  const adapter = new HttpConversationAdapter(
    {
      type: 'http',
      baseUrl,
      qaOnly: true,
      bindings: { world: bindings },
      identity: {
        path: '/api/me',
        assertions: [{ path: 'id', op: 'eq', expected: '$actor.id' }],
      },
      chat: {
        path: '/api/chat',
        body: {
          message: '$message',
          stage: '$step.id',
          conversationId: '$conversationId',
          messageId: '$messageId',
        },
      },
      responsePaths: ['answer'],
      allowFixtureWrites: true,
      fixtures: {
        lessonHappens: { method: 'POST', path: '/api/fixture', body: {} },
      },
      verifiers: {
        created: checks('created'),
        scheduled: checks('scheduled'),
        happened: checks('happened'),
        feedback: checks('feedback'),
      },
    },
    { env: { PARENT: 'parent', TEACHER: 'teacher', CHILD: 'child' } },
  );
  const model = new JsonChatModel({
    url: baseUrl + '/model',
    model: 'local-protocol-fixture',
  });
  const steps = [
    {
      id: 'create',
      actorId: 'parent',
      goal: 'Create a reading lesson',
      effect: 'write',
      verifierId: 'created',
      exports: { created: 'created' },
    },
    {
      id: 'schedule',
      actorId: 'teacher',
      goal: 'Schedule the created lesson',
      dependsOn: ['create'],
      effect: 'write',
      verifierId: 'scheduled',
    },
    {
      id: 'happens',
      actorId: 'teacher',
      goal: 'Simulate lesson completion',
      kind: 'fixture',
      fixtureId: 'lessonHappens',
      dependsOn: ['schedule'],
      effect: 'write',
      verifierId: 'happened',
    },
    {
      id: 'feedback',
      actorId: 'teacher',
      goal: 'Record lesson feedback',
      dependsOn: ['happens'],
      effect: 'write',
      verifierId: 'feedback',
      exports: { summary: 'feedback' },
    },
    {
      id: 'summary',
      actorId: 'child',
      goal: 'Read teacher feedback',
      dependsOn: ['feedback'],
      verifierId: 'feedback',
    },
  ];
  const run = new CampaignRun(
    {
      version: 1,
      name: 'HTTP protocol lifecycle',
      target: 'fixture',
      roles,
      scenarios: [{ id: 'lesson', title: 'Lesson', worldId: 'world', steps }],
    },
    { adapter, actorModel: model },
  );
  const result = await run.start();
  assert.equal(
    result.status,
    'completed',
    JSON.stringify(
      result.steps.map((step) => ({
        id: step.id,
        error: step.error,
        status: step.status,
      })),
    ),
  );
  assert.deepEqual(operations, [
    'create',
    'schedule',
    'happens',
    'feedback',
    'summary',
  ]);
  assert.equal(result.steps[4].response.text, 'Great progress');
  assert.equal(result.steps[3].artifacts.summary, 'Great progress');
  assert.equal(
    modelPurposes.filter((purpose) => purpose === 'enhance').length,
    1,
  );
  assert.equal(
    modelPurposes.filter((purpose) => purpose === 'judge').length,
    4,
  );
  assert.equal(result.steps[1].conversationId, result.steps[3].conversationId);
  assert.notEqual(
    result.steps[0].conversationId,
    result.steps[4].conversationId,
  );
});
