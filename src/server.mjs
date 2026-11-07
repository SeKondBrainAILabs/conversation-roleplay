/** Loopback dashboard API. Configuration and credentials are server-side; browsers cannot supply endpoints. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RunStore } from './store.mjs';
import { CampaignRun } from './engine.mjs';
import { DemoModel } from './model.mjs';
import { createAdapter } from './adapters.mjs';
import { DemoRepairAdapter } from './repair.mjs';
import { validateCampaign, validateGeneratedCampaign } from './contracts.mjs';
import { assert, redact } from './util.mjs';
import {
  preflightCampaignRepairs,
  RESERVED_REPAIR_STATES,
} from './clarifications.mjs';
import { createServiceStack } from './services.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const example = () =>
  JSON.parse(
    readFileSync(join(root, 'examples/lesson-lifecycle.json'), 'utf8'),
  );
function collectSecrets(config, env) {
  const names = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith('HeadersEnv') || key === 'headersEnv') {
        for (const [header, name] of Object.entries(item ?? {}))
          if (
            !['x-app-id', 'x-product', 'x-organization-id'].includes(
              header.toLowerCase(),
            )
          )
            names.add(name);
      } else if (
        /^(bearer|serviceKey|appKey|clientSecret|token|password|apiKey)Env$/i.test(
          key,
        ) &&
        typeof item === 'string'
      )
        names.add(item);
      else walk(item);
    }
  };
  walk(config);
  return [...names].map((name) => env[name]).filter(Boolean);
}
export function createLab(
  config = {},
  {
    env = process.env,
    directory = join(process.cwd(), '.roleplay-runs'),
    fetchImpl,
  } = {},
) {
  const secrets = collectSecrets(config, env);
  if (env.ROLEPLAY_DEPLOY_TOKEN) secrets.push(env.ROLEPLAY_DEPLOY_TOKEN);
  const store = new RunStore(directory, { secrets });
  const releaseLease = store.acquireLease();
  try {
    store.recoverInterrupted();
  } catch (error) {
    releaseLease();
    throw error;
  }
  const runs = new Map();
  const serviceStack = createServiceStack(config, { env, fetchImpl });
  const targets = {
    demo: { type: 'demo', label: 'Local simulator · no product traffic' },
    ...(config.targets ?? {}),
  };
  const csrf = randomBytes(32).toString('hex');
  let planning = false;
  let launching = 0;
  let drainUntil =
    env.ROLEPLAY_START_DRAINED === 'true' ? Date.now() + 300000 : 0;
  const busy = (message) => {
    throw Object.assign(new Error(message), { httpStatus: 409 });
  };
  const requireAccepting = () => {
    if (drainUntil > Date.now())
      busy('Deployment is draining; try after the update completes');
  };
  const quiesce = () => {
    drainUntil = Infinity;
    for (const run of runs.values()) run.stop();
  };
  const deploymentState = () => {
    const all = store.list();
    const active = all.filter((run) =>
      ['preparing', 'running', 'paused', 'stopping'].includes(run.status),
    ).length;
    const uncertain = all.filter((run) =>
      run.steps?.some(
        (step) =>
          step.status === 'outcome_unknown' ||
          RESERVED_REPAIR_STATES.has(step.repair?.status) ||
          RESERVED_REPAIR_STATES.has(step.incident?.status),
      ),
    ).length;
    return {
      safeToReplace: !active && !uncertain && !planning && !launching,
      active,
      uncertain,
      planning,
      launching,
      draining: drainUntil > Date.now(),
      revision: env.ROLEPLAY_REVISION ?? null,
    };
  };
  const model = (kind) => serviceStack.model(kind);
  const publicRun = (id) => runs.get(id)?.snapshot() ?? store.read(id);
  const manifest = (target) => {
    assert(targets[target], 'Unknown configured target');
    return createAdapter(targets[target], { env, fetchImpl }).manifest();
  };
  async function launch(campaign) {
    requireAccepting();
    launching++;
    try {
      return await launchChecked(campaign);
    } finally {
      launching--;
    }
  }
  async function launchChecked(campaign) {
    campaign = validateCampaign(campaign);
    assert(targets[campaign.target], 'Unknown configured target');
    assert(
      [...runs.values()].filter((run) =>
        ['preparing', 'running', 'paused', 'stopping'].includes(
          run.state.status,
        ),
      ).length < (config.maxActiveRuns ?? 3),
      'Active campaign limit reached',
    );
    const adapter = createAdapter(targets[campaign.target], { env, fetchImpl });
    const demo = adapter.kind === 'demo';
    const repairCheck = demo
      ? { enabled: false, ready: true }
      : preflightCampaignRepairs(
          campaign,
          targets[campaign.target].repairContracts,
          serviceStack.repairAdapter,
        );
    assert(
      !repairCheck.enabled || repairCheck.ready,
      'HAI answers required before starting; run repair preflight',
    );
    const workspace = demo ? null : await serviceStack.preflight();
    requireAccepting();
    const scopeHashes = adapter.isolationScopes?.(campaign) ?? [];
    for (const prior of store.list()) {
      const uncertain = prior.steps?.some(
        (step) =>
          step.status === 'outcome_unknown' ||
          RESERVED_REPAIR_STATES.has(step.repair?.status) ||
          RESERVED_REPAIR_STATES.has(step.incident?.status),
      );
      if (
        ['preparing', 'running', 'paused', 'stopping'].includes(prior.status) ||
        uncertain
      )
        assert(
          !(prior.scopeHashes ?? []).some((hash) => scopeHashes.includes(hash)),
          'QA scope is reserved by an active or uncertain run; use a fresh isolated fixture',
        );
    }
    const run = new CampaignRun(campaign, {
      adapter,
      actorModel: demo ? new DemoModel() : model('actorModel'),
      judgeModel: demo ? new DemoModel() : model('judgeModel'),
      repairAdapter: demo
        ? new DemoRepairAdapter()
        : serviceStack.repairAdapter,
      incidentClient: demo ? undefined : serviceStack.incidentClient,
      store,
      secrets,
    });
    run.state.scopeHashes = scopeHashes;
    if (workspace) run.state.workspace = workspace;
    run.persist();
    runs.set(run.state.id, run);
    run.completion = run.start();
    return run;
  }
  const json = (res, status, value) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(redact(value, secrets)));
  };
  const body = async (req) => {
    let size = 0,
      chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      assert(size <= 1_000_000, 'Request body too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const host = `127.0.0.1:${address.port}`;
      const hosts = [
        host,
        `localhost:${address.port}`,
        `127.0.0.1:${env.ROLEPLAY_PUBLIC_PORT ?? address.port}`,
        `localhost:${env.ROLEPLAY_PUBLIC_PORT ?? address.port}`,
      ];
      assert(hosts.includes(req.headers.host), 'Untrusted Host header');
      if (req.headers.origin)
        assert(
          hosts
            .map((hostname) => `http://${hostname}`)
            .includes(req.headers.origin),
          'Cross-origin request refused',
        );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      );
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/deployment-state')
        return json(res, 200, deploymentState());
      if (
        req.method === 'POST' &&
        ['/api/deployment/drain', '/api/deployment/resume'].includes(
          url.pathname,
        )
      ) {
        const expected = Buffer.from(env.ROLEPLAY_DEPLOY_TOKEN ?? '');
        const supplied = Buffer.from(
          String(req.headers['x-roleplay-deploy-token'] ?? ''),
        );
        assert(
          expected.length >= 32 &&
            supplied.length === expected.length &&
            timingSafeEqual(supplied, expected),
          'Invalid deployment token',
        );
        if (url.pathname.endsWith('/drain')) {
          if (!deploymentState().safeToReplace)
            busy('Campaign or uncertain request reserves this deployment');
          drainUntil = Date.now() + 300000;
        } else drainUntil = 0;
        return json(res, 200, deploymentState());
      }
      if (req.method === 'GET' && url.pathname === '/healthz')
        return json(res, 200, {
          status: 'ok',
          service: 'conversation-roleplay',
          revision: env.ROLEPLAY_REVISION ?? null,
        });
      if (
        req.method === 'GET' &&
        ['/readyz', '/api/services'].includes(url.pathname)
      ) {
        const readiness = await serviceStack.check();
        return json(
          res,
          url.pathname === '/readyz' && !readiness.ready ? 503 : 200,
          readiness,
        );
      }
      if (req.method === 'POST') {
        const supplied = Buffer.from(
          String(req.headers['x-roleplay-token'] ?? ''),
        );
        assert(
          supplied.length === csrf.length &&
            timingSafeEqual(supplied, Buffer.from(csrf)),
          'Invalid dashboard request token',
        );
      }
      if (req.method === 'GET' && url.pathname === '/api/meta')
        return json(res, 200, {
          csrf,
          targets: Object.entries(targets).map(([id, target]) => ({
            id,
            label: target.label ?? id,
            type: target.type,
            ...manifest(id),
          })),
          modelConfigured: Boolean(
            config.services?.coreAi ?? config.llm ?? config.actorModel,
          ),
          servicesConfigured: Boolean(config.services),
          example: example(),
        });
      if (req.method === 'GET' && url.pathname === '/api/runs')
        return json(
          res,
          200,
          store.list().map((run) => ({
            id: run.id,
            name: run.name,
            target: run.target,
            status: run.status,
            demo: run.demo,
            startedAt: run.startedAt,
            summary: run.summary,
          })),
        );
      if (req.method === 'POST' && url.pathname === '/api/repairs/preflight') {
        const campaign = validateCampaign(await body(req));
        assert(targets[campaign.target], 'Unknown configured target');
        return json(
          res,
          200,
          targets[campaign.target].type === 'demo'
            ? { enabled: false, ready: true, contracts: [] }
            : preflightCampaignRepairs(
                campaign,
                targets[campaign.target].repairContracts,
                serviceStack.repairAdapter,
              ),
        );
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const run = await launch(await body(req));
        return json(res, 202, run.snapshot());
      }
      const match = url.pathname.match(
        /^\/api\/runs\/([\w-]+)(?:\/(events|control|export))?$/,
      );
      if (match) {
        const [, id, action] = match;
        if (req.method === 'GET' && action === 'events') {
          publicRun(id);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const send = (snapshot) =>
            res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
          send(publicRun(id));
          const run = runs.get(id);
          run?.on('update', send);
          const keepalive = setInterval(
            () => res.write(': keepalive\n\n'),
            15000,
          );
          req.on('close', () => {
            clearInterval(keepalive);
            run?.off('update', send);
          });
          return;
        }
        if (req.method === 'GET') {
          if (action === 'export')
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="roleplay-${id}.json"`,
            );
          return json(res, 200, publicRun(id));
        }
        if (req.method === 'POST' && action === 'control') {
          const run = runs.get(id);
          assert(
            run,
            'This run is archived; it can be inspected but not replayed',
          );
          const { command } = await body(req);
          assert(
            ['pause', 'resume', 'stop'].includes(command),
            'Unknown run control',
          );
          if (command === 'resume') requireAccepting();
          run[command]();
          return json(res, 200, run.snapshot());
        }
      }
      if (
        req.method === 'POST' &&
        ['/api/plan', '/api/roles/enhance'].includes(url.pathname)
      ) {
        requireAccepting();
        assert(!planning, 'A planning request is already active');
        const input = await body(req);
        assert(
          typeof input.brief === 'string' &&
            input.brief.length > 0 &&
            input.brief.length <= 8000 &&
            Array.isArray(input.roles) &&
            input.roles.length > 0 &&
            input.roles.length <= 30,
          'Supply roles and a bounded brief',
        );
        validateCampaign({
          version: 1,
          name: input.name || 'Generated campaign',
          target: input.target,
          roles: input.roles,
          scenarios: [
            {
              id: 'validation',
              title: 'Validate supplied roles',
              steps: [
                {
                  id: 'check',
                  actorId: input.roles[0].id,
                  goal: 'Validate supplied roles',
                },
              ],
            },
          ],
        });
        assert(
          targets[input.target] && targets[input.target].type !== 'demo',
          'Configure an LLM and real target before generating scenarios; the demo example is already provided',
        );
        const hooks = manifest(input.target);
        planning = true;
        try {
          if (url.pathname.endsWith('enhance'))
            return json(
              res,
              200,
              await model('actorModel').complete('enhance', {
                roles: input.roles,
                brief: input.brief,
              }),
            );
          const candidate = await model('actorModel').complete('plan', {
            target: input.target,
            roles: input.roles,
            name: input.name,
            brief: input.brief,
            hooks,
          });
          return json(
            res,
            200,
            validateGeneratedCampaign(candidate, {
              target: input.target,
              roles: input.roles,
              verifierIds: hooks.verifiers.map((hook) => hook.id),
              fixtureIds: hooks.fixtures.map((hook) => hook.id),
              repairContractIds: hooks.repairs.map((hook) => hook.id),
              incidentContractIds: (hooks.incidents ?? []).map(
                (hook) => hook.id,
              ),
              worlds: hooks.worlds,
            }),
          );
        } finally {
          planning = false;
        }
      }
      if (
        req.method === 'GET' &&
        ['/', '/app.js', '/style.css'].includes(url.pathname)
      ) {
        const path = join(
          root,
          'web',
          url.pathname === '/' ? 'index.html' : url.pathname.slice(1),
        );
        res.writeHead(200, {
          'Content-Type': {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
          }[extname(path)],
        });
        res.end(readFileSync(path));
        return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent)
        json(res, error.httpStatus ?? (error.code === 'ENOENT' ? 404 : 400), {
          error: error.message,
        });
      else res.end();
    }
  });
  server.on('close', () => {
    quiesce();
    Promise.allSettled([...runs.values()].map((run) => run.completion)).then(
      releaseLease,
    );
  });
  return {
    server,
    store,
    runs,
    launch,
    publicRun,
    services: serviceStack,
    quiesce,
    dispose: releaseLease,
  };
}
