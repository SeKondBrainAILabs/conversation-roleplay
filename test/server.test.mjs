/** Browser API integration: CSRF, local origin, archived inspection and real SSE snapshots. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLab } from '../src/index.mjs';
import { example } from '../src/server.mjs';

test('a second process instance cannot rewrite an active run directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-exclusive-'));
  const first = createLab({}, { directory });
  assert.throws(() => createLab({}, { directory }), /already open/);
  first.dispose();
  const next = createLab({}, { directory });
  next.dispose();
});

test('dashboard exposes manifests rather than credentials and requires a local CSRF token for actions', async (t) => {
  const lab = createLab(
    {
      targets: {
        configured: {
          type: 'http',
          baseUrl: 'http://private-target',
          bindings: {
            secretWorld: {
              secretActor: { headersEnv: { Authorization: 'PRIVATE_AUTH' } },
            },
          },
        },
      },
    },
    {
      directory: mkdtempSync(join(tmpdir(), 'roleplay-server-')),
      env: { PRIVATE_AUTH: 'secret-value-98765' },
    },
  );
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  t.after(() => lab.server.close());
  const base = `http://127.0.0.1:${lab.server.address().port}`;
  const meta = await (await fetch(base + '/api/meta')).json();
  assert.equal(meta.targets.length, 2);
  assert.ok(!JSON.stringify(meta).includes('secret-value-98765'));
  assert.ok(!JSON.stringify(meta).includes('PRIVATE_AUTH'));
  assert.equal(
    (
      await fetch(base + '/api/runs', {
        method: 'POST',
        body: JSON.stringify(example()),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + '/api/runs', {
        method: 'POST',
        headers: {
          'X-Roleplay-Token': meta.csrf,
          Origin: 'https://untrusted.test',
        },
        body: JSON.stringify(example()),
      })
    ).status,
    400,
  );
  const campaign = example();
  campaign.scenarios = [campaign.scenarios[1]];
  const started = await fetch(base + '/api/runs', {
    method: 'POST',
    headers: { 'X-Roleplay-Token': meta.csrf },
    body: JSON.stringify(campaign),
  });
  assert.equal(started.status, 202);
  const run = await started.json();
  const result = await lab.runs.get(run.id).completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.qualified, false);
  const exported = await fetch(`${base}/api/runs/${run.id}/export`);
  assert.ok(exported.headers.get('content-disposition').includes(run.id));
  const data = await exported.json();
  assert.ok(data.steps[0].transcript.length > 0);
  const events = await fetch(`${base}/api/runs/${run.id}/events`);
  const reader = events.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /data: /);
  await reader.cancel();
});
