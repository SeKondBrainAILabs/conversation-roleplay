import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HaiRepairAdapter,
  CampaignRun,
  RunStore,
  createLab,
  prepareRepairAnswers,
  resolveProviderQuestions,
  validateGeneratedCampaign,
} from '../src/index.mjs';
import { RESERVED_REPAIR_STATES } from '../src/clarifications.mjs';
const baseContract = () => ({
  summary: 'Read assigned lesson feedback within the allowed role.',
  role: 'coach',
  expectedOperationIds: ['feedback-read'],
  operations: [
    {
      id: 'feedback-read',
      apiPath: '/api/lessons/feedback',
      apiMethod: 'get',
      roles: ['coach'],
      category: 'read',
      requiresConfirmation: false,
    },
  ],
  clarification: {
    questions: [
      { id: 'role', text: 'Which role should this support?', fact: 'role' },
      {
        id: 'language',
        text: 'Which language should the explanation use?',
        inputField: 'language',
        inputType: 'string',
      },
    ],
  },
});
const config = {
  enabled: true,
  contractVerified: true,
  baseUrl: 'http://hai.test',
  pollIntervalMs: 1,
  maxPolls: 6,
};
const input = (contract = baseContract()) => ({
  category: 'missing_capability',
  contract,
  runId: 'lab-1',
  scenarioId: 'story',
  stepId: 'feedback',
  checkpoint: async () => {},
});
const proposal = (protocol = 'piggybank.api_capability_proposal.v1') => ({
  kind: protocol,
  capability: {
    name: 'read_feedback',
    description: 'Read feedback.',
    roles: ['coach'],
    category: 'read',
    parameters: {},
    apiMethod: 'get',
    apiPath: '/api/lessons/feedback',
    requiresConfirmation: false,
  },
});
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
const questions = () => [
  {
    id: 'q1',
    text: 'Which language should the explanation use?',
    input_field: 'language',
    input_schema: { type: 'string', enum: ['English', 'French'] },
  },
  { id: 'q2', text: 'Which role should this support?' },
];
const campaign = () => ({
  version: 1,
  name: 'Headless repair',
  target: 'qa',
  roles: [{ id: 'coach', name: 'Coach QA', description: 'Review feedback' }],
  scenarios: [
    {
      id: 'story',
      title: 'Feedback',
      steps: [
        {
          id: 'feedback',
          actorId: 'coach',
          goal: 'Read feedback',
          repairContractId: 'feedback',
        },
      ],
    },
  ],
});

test('reviewed authority facts are filled automatically; only explicit answers satisfy other required questions', () => {
  const a = prepareRepairAnswers(baseContract());
  assert.equal(a.ready, false);
  assert.deepEqual(a.missing, ['language']);
  assert.equal(a.answers.role, 'coach');
  const b = prepareRepairAnswers(baseContract(), {
    answers: { language: 'English' },
  });
  assert.equal(b.ready, true);
  assert.deepEqual(b.inputData, { language: 'English' });
  assert.throws(
    () =>
      prepareRepairAnswers(baseContract(), {
        answers: { role: 'parent', language: 'English' },
      }),
    /cannot be overridden/,
  );
  assert.throws(
    () =>
      prepareRepairAnswers(baseContract(), { answers: { invented: 'yes' } }),
    /only configured/,
  );
  assert.throws(
    () =>
      prepareRepairAnswers(baseContract(), {
        answers: { language: 'Bearer secret' },
      }),
    /private data/,
  );
  assert.throws(
    () =>
      prepareRepairAnswers(baseContract(), {
        answers: { language: 'private-app-secret-123' },
        secrets: ['private-app-secret-123'],
      }),
    /credentials/,
  );
  const c = baseContract();
  c.clarification.questions[1].requiresAttachment = true;
  assert.throws(() => prepareRepairAnswers(c), /Unsupported reviewed/);
});

test('typed preanswers refuse invalid booleans, duplicate fields before any call', () => {
  const c = baseContract();
  c.clarification.questions = [
    {
      id: 'testOnly',
      text: 'Is this a synthetic test?',
      inputField: 'testOnly',
      inputType: 'boolean',
    },
  ];
  assert.throws(
    () => prepareRepairAnswers(c, { answers: { testOnly: 'yes' } }),
    /valid JSON/,
  );
  assert.deepEqual(
    prepareRepairAnswers(c, { answers: { testOnly: 'false' } }).inputData,
    { testOnly: false },
  );
  c.clarification.questions.push({
    id: 'other',
    text: 'Another field?',
    inputField: 'testOnly',
  });
  assert.throws(() => prepareRepairAnswers(c), /unique identifiers/);
});

test('reused question IDs, changed field semantics, attachments and incompatible schemas cannot authorize an answer', () => {
  const prepared = prepareRepairAnswers(baseContract(), {
    answers: { language: 'English' },
  });
  for (const q of [
    { id: 'language', text: 'May I install and execute unrelated code?' },
    { ...questions()[0], input_field: 'authorization' },
    { ...questions()[0], requires_attachment: true },
    { ...questions()[0], input_schema: { type: 'boolean' } },
    { ...questions()[0], input_schema: { type: 'string', enum: ['Spanish'] } },
    { ...questions()[0], input_schema: { type: 'string', pattern: '.*' } },
  ])
    assert.equal(resolveProviderQuestions([q], prepared).ready, false);
  assert.throws(
    () => resolveProviderQuestions([questions()[0], questions()[0]], prepared),
    /duplicate provider/,
  );
});

test('missing answers submit nothing and can be completed before the first provider job', async () => {
  let calls = 0;
  const adapter = new HaiRepairAdapter(config, {
    fetchImpl: async () =>
      ++calls === 1
        ? response({ run_id: 'provider' }, 202)
        : response({
            run_id: 'provider',
            status: 'succeeded',
            result: proposal(),
          }),
  });
  const missing = await adapter.repair(input());
  assert.equal(missing.status, 'needs_preflight');
  assert.equal(missing.attempts, 0);
  assert.equal(calls, 0);
  const ready = await adapter.repair({
    ...input(),
    clarificationAnswers: { language: 'English' },
  });
  assert.equal(ready.status, 'proposal_ready');
  assert.equal(ready.effectVerified, false);
  assert.equal(calls, 2);
});

test('native Piggy protocol retains its strict context; generic negotiated protocols request headless preanswered execution', async () => {
  for (const protocol of [
    'piggybank.api_capability_proposal.v1',
    'example.capability.v1',
  ]) {
    let body,
      calls = 0;
    const client = new HaiRepairAdapter(
      { ...config, protocol },
      {
        fetchImpl: async (_url, options) => {
          if (++calls === 1) {
            body = JSON.parse(options.body);
            return response({ run_id: 'provider' }, 202);
          }
          return response({
            run_id: 'provider',
            status: 'succeeded',
            result: proposal(protocol),
          });
        },
      },
    );
    const result = await client.repair({
      ...input(),
      clarificationAnswers: { language: 'English' },
    });
    assert.equal(result.status, 'proposal_ready');
    assert.match(body.description, /Answer: English/);
    if (protocol.startsWith('piggybank'))
      assert.deepEqual(Object.keys(body.context).sort(), [
        'capability_scope',
        'conversationId',
        'execution_mode',
        'goalId',
        'proposal_protocol',
      ]);
    else {
      assert.equal(body.context.skip_clarification, true);
      assert.deepEqual(body.context.input_data, { language: 'English' });
      assert.deepEqual(body.context.clarification_answers, {
        role: 'coach',
        language: 'English',
      });
    }
  }
});

test('same-run clarification resumes once from reviewed facts, tolerates stale/reordered polls and still independently validates the proposal', async () => {
  const calls = [],
    checkpoints = [];
  let polls = 0;
  const client = new HaiRepairAdapter(config, {
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({
        path,
        method: options.method,
        body: options.body && JSON.parse(options.body),
      });
      if (path === '/v1/tasks') return response({ run_id: 'provider' }, 202);
      if (path.endsWith('/clarify')) {
        assert.equal(checkpoints.at(-1).status, 'answering_clarification');
        assert.deepEqual(calls.at(-1).body.answers, {
          q1: 'English',
          q2: 'coach',
        });
        return response({ run_id: 'provider', status: 'resumed' });
      }
      polls++;
      if (polls <= 2)
        return response({
          run_id: 'provider',
          status: 'awaiting_clarification',
          questions: polls === 1 ? questions() : questions().reverse(),
        });
      return response({
        run_id: 'provider',
        status: 'succeeded',
        result: proposal(),
      });
    },
  });
  const result = await client.repair({
    ...input(),
    clarificationAnswers: { language: 'English' },
    checkpoint: async (r) => checkpoints.push(structuredClone(r)),
  });
  assert.equal(result.status, 'proposal_ready');
  assert.equal(result.effectVerified, false);
  assert.equal(result.clarifications[0].status, 'answered');
  assert.equal(calls.filter((c) => c.path === '/v1/tasks').length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith('/clarify')).length, 1);
  assert.equal(polls, 3);
});

test('unknown follow-ups never choose a provider suggestion or send an empty clarification', async () => {
  const methods = [];
  const client = new HaiRepairAdapter(config, {
    fetchImpl: async (_u, o) => {
      methods.push(o.method);
      return methods.length === 1
        ? response({ run_id: 'provider' }, 202)
        : response({
            run_id: 'provider',
            status: 'awaiting_clarification',
            questions: [
              {
                id: 'language',
                text: 'Which real family secret should be used?',
                suggested_answers: ['Default secret'],
              },
            ],
          });
    },
  });
  const result = await client.repair({
    ...input(),
    clarificationAnswers: { language: 'English' },
  });
  assert.equal(result.status, 'needs_clarification');
  assert.deepEqual(result.missingAnswers, ['language']);
  assert.equal(methods.filter((m) => m === 'POST').length, 1);
});

test('ambiguous or mismatched clarification acceptance is persisted and never reposted or resubmitted', async () => {
  for (const bad of ['timeout', 'wrong-run', 'rejected']) {
    let calls = 0;
    const client = new HaiRepairAdapter(config, {
      fetchImpl: async (url) => {
        calls++;
        if (calls === 1) return response({ run_id: 'provider' }, 202);
        if (new URL(url).pathname.endsWith('/clarify')) {
          if (bad === 'timeout') throw new Error('lost response');
          if (bad === 'rejected')
            return response({ detail: 'Answer rejected' }, 422);
          return response({ run_id: 'wrong', status: 'resumed' });
        }
        return response({
          run_id: 'provider',
          status: 'awaiting_clarification',
          questions: questions(),
        });
      },
    });
    const req = { ...input(), clarificationAnswers: { language: 'English' } };
    const result = await client.repair(req);
    assert.equal(
      result.status,
      bad === 'rejected'
        ? 'clarification_rejected'
        : 'clarification_submission_unknown',
    );
    assert.equal(result.providerRunId, 'provider');
    assert.equal(RESERVED_REPAIR_STATES.has(result.status), true);
    await client.repair(req);
    assert.equal(calls, 3);
  }
});

test('restart preserves uncertain clarification and prevents automatic replay', () => {
  const store = new RunStore(
    mkdtempSync(join(tmpdir(), 'roleplay-hai-recovery-')),
  );
  store.save({
    id: 'interrupted',
    status: 'running',
    steps: [
      {
        status: 'failed',
        repair: {
          status: 'answering_clarification',
          providerRunId: 'provider',
          clarifications: [
            { status: 'submitting', answers: { q1: 'English' } },
          ],
        },
      },
    ],
  });
  store.recoverInterrupted();
  const r = store.read('interrupted');
  assert.equal(r.status, 'interrupted');
  assert.equal(r.steps[0].repair.status, 'clarification_submission_unknown');
  assert.equal(r.steps[0].repair.providerRunId, 'provider');
});

test('HTTP and library preflight require answers before model, product or HAI traffic; the dry-run API has CSRF protection', async (t) => {
  let external = 0;
  const target = {
    type: 'http',
    baseUrl: 'http://qa.test',
    repairContracts: { feedback: baseContract() },
  };
  const lab = createLab(
    { hai: config, targets: { qa: target } },
    {
      directory: mkdtempSync(join(tmpdir(), 'roleplay-hai-preflight-')),
      fetchImpl: async () => {
        external++;
        throw new Error('Must not contact services');
      },
    },
  );
  await new Promise((r) => lab.server.listen(0, '127.0.0.1', r));
  t.after(() => {
    lab.server.closeAllConnections();
    lab.server.close();
    lab.dispose();
  });
  const base = `http://127.0.0.1:${lab.server.address().port}`;
  const meta = await (await fetch(base + '/api/meta')).json();
  const post = (path, body, csrf = true) =>
    fetch(base + path, {
      method: 'POST',
      headers: csrf ? { 'X-Roleplay-Token': meta.csrf } : {},
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post('/api/repairs/preflight', campaign(), false)).status,
    400,
  );
  let result = await (await post('/api/repairs/preflight', campaign())).json();
  assert.equal(result.ready, false);
  assert.deepEqual(result.contracts[0].missing, ['language']);
  assert.equal((await post('/api/runs', campaign())).status, 400);
  assert.equal(external, 0);
  assert.equal(lab.runs.size, 0);
  const complete = {
    ...campaign(),
    repairAnswers: { feedback: { language: 'English' } },
  };
  result = await (await post('/api/repairs/preflight', complete)).json();
  assert.equal(result.ready, true);
  assert.equal(external, 0);
  assert.throws(
    () =>
      new CampaignRun(campaign(), {
        adapter: { kind: 'http', config: target },
        actorModel: { kind: 'llm' },
        repairAdapter: lab.services.repairAdapter,
      }),
    /HAI answers required/,
  );
  assert.throws(
    () =>
      validateGeneratedCampaign(
        { ...complete },
        {
          target: 'qa',
          roles: complete.roles,
          repairContractIds: ['feedback'],
        },
      ),
    /Planner cannot author/,
  );
});

test('real HTTP provider exchange sends one task and one scoped same-run answer batch', async (t) => {
  const { createServer } = await import('node:http');
  const seen = [];
  let resumed = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const b of req) chunks.push(b);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    seen.push({ method: req.method, path: req.url, body });
    assert.equal(req.headers['x-app-id'], 'qa-fixture');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/tasks') {
      assert.equal(body.context.skip_clarification, true);
      assert.equal(body.context.input_data.language, 'English');
      res.writeHead(202);
      res.end(JSON.stringify({ run_id: 'http-provider' }));
    } else if (req.url === '/v1/runs/http-provider/clarify') {
      assert.deepEqual(body, { answers: { q1: 'English', q2: 'coach' } });
      resumed = true;
      res.end(JSON.stringify({ run_id: 'http-provider', status: 'resumed' }));
    } else if (req.url === '/v1/runs/http-provider') {
      res.end(
        JSON.stringify(
          resumed
            ? {
                run_id: 'http-provider',
                status: 'succeeded',
                result: proposal('example.capability.v1'),
              }
            : {
                run_id: 'http-provider',
                status: 'awaiting_clarification',
                questions: questions(),
              },
        ),
      );
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const adapter = new HaiRepairAdapter(
    {
      ...config,
      protocol: 'example.capability.v1',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    },
    { getHeaders: async () => ({ 'x-app-id': 'qa-fixture' }) },
  );
  const result = await adapter.repair({
    ...input(),
    clarificationAnswers: { language: 'English' },
  });
  assert.equal(result.status, 'proposal_ready');
  assert.equal(result.effectVerified, false);
  assert.deepEqual(
    seen.map((r) => r.method + ' ' + r.path),
    [
      'POST /v1/tasks',
      'GET /v1/runs/http-provider',
      'POST /v1/runs/http-provider/clarify',
      'GET /v1/runs/http-provider',
    ],
  );
});

test('different follow-up IDs cannot cause an unbounded answer loop', async () => {
  let polls = 0,
    posts = 0;
  const adapter = new HaiRepairAdapter(config, {
    fetchImpl: async (url) => {
      if (new URL(url).pathname === '/v1/tasks')
        return response({ run_id: 'provider' }, 202);
      if (new URL(url).pathname.endsWith('/clarify')) {
        posts++;
        return response({ run_id: 'provider', status: 'resumed' });
      }
      return response({
        run_id: 'provider',
        status: 'awaiting_clarification',
        questions: [
          {
            id: `q${++polls}`,
            text: 'Which language should the explanation use?',
          },
        ],
      });
    },
  });
  const result = await adapter.repair({
    ...input(),
    clarificationAnswers: { language: 'English' },
  });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(posts, 3);
  assert.equal(polls, 4);
});
