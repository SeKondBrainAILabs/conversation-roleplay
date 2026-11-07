import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { example } from '../src/server.mjs';

test('SIGTERM closes a live dashboard stream, releases the lease and preserves archived evidence', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-shutdown-'));
  const processes = [];
  t.after(() => {
    for (const child of processes)
      if (child.exitCode === null) child.kill('SIGKILL');
  });
  const start = async () => {
    const child = spawn(
      process.execPath,
      [resolve('src/cli.mjs'), 'serve', '--port', '0', '--runs', directory],
      {
        env: {
          ...process.env,
          ROLEPLAY_CONFIG: '',
          ROLEPLAY_HOST: '127.0.0.1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    processes.push(child);
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('CLI did not start')),
        5000,
      );
      child.stdout.on('data', (bytes) => {
        const match = String(bytes).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('CLI exited before startup'));
      });
    });
    return { child, base };
  };
  const { child, base } = await start();
  const meta = await (await fetch(base + '/api/meta')).json();
  const campaign = example();
  campaign.scenarios = [campaign.scenarios[1]];
  const run = await (
    await fetch(base + '/api/runs', {
      method: 'POST',
      headers: { 'X-Roleplay-Token': meta.csrf },
      body: JSON.stringify(campaign),
    })
  ).json();
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await (await fetch(base + '/api/runs/' + run.id)).json();
    if (snapshot.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stream = await fetch(`${base}/api/runs/${run.id}/events`);
  const reader = stream.body.getReader();
  await reader.read();
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  await reader.cancel().catch(() => {});
  assert.equal(
    existsSync(join(directory, '.roleplay-lock')),
    false,
    'A container restart must not inherit a stale PID lease',
  );
  const restarted = await start();
  const archived = await (
    await fetch(restarted.base + '/api/runs/' + run.id)
  ).json();
  assert.equal(archived.status, 'completed');
  const finished = once(restarted.child, 'exit');
  restarted.child.kill('SIGTERM');
  await finished;
});
