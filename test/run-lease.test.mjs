import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { RunStore } from '../src/store.mjs';

const linux = { skip: process.platform !== 'linux' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-lease-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, '.roleplay-lock'), store: new RunStore(directory) };
}

async function holder(directory, { env = process.env } = {}) {
  const source = new URL('../src/store.mjs', import.meta.url).href;
  const code = `import { RunStore } from ${JSON.stringify(source)};
    try {
      const release = new RunStore(process.argv[1]).acquireLease();
      process.send({ acquired: true });
      process.on('message', () => { release(); process.exit(0); });
    } catch (error) { process.send({ acquired: false, error: error.message }); process.exit(2); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, directory], {
    env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const result = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'error').then(([error]) => { throw error; }),
  ]);
  return { child, result };
}

test('live ownership excludes a second instance and release preserves the guard inode', (t) => {
  const { directory, store, path } = fixture(t);
  const release = store.acquireLease();
  const before = readFileSync(path, 'utf8');
  assert.throws(() => new RunStore(directory).acquireLease(), /already open/);
  assert.equal(readFileSync(path, 'utf8'), before);
  const guard = join(directory, '.roleplay-kernel-lock');
  const initialInode = process.platform === 'linux' ? statSync(guard).ino : null;
  release(); release();
  assert.equal(existsSync(path), false);
  if (initialInode !== null) assert.equal(statSync(guard).ino, initialInode);
  const next = store.acquireLease();
  next();
});

test('legacy PID-only metadata is never stolen, including a reused current PID', (t) => {
  const { store, path } = fixture(t);
  const legacy = JSON.stringify({ owner: 'legacy-owner', pid: process.pid });
  writeFileSync(path, legacy);
  assert.throws(() => store.acquireLease(), /Cannot verify|already open/);
  assert.equal(readFileSync(path, 'utf8'), legacy);
  unlinkSync(path); // Explicit test-owner recovery after proving no prior process.
  store.acquireLease()();
});

test('PID reuse, a different namespace and a reboot recover only under kernel exclusion', linux, (t) => {
  const { store, path } = fixture(t);
  const release = store.acquireLease();
  const initial = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(initial.mechanism, 'kernel-flock');
  assert.match(initial.bootId, /^[a-f\d-]{36}$/);
  assert.match(initial.startTicks, /^\d+$/);
  release();
  for (const stale of [
    { ...initial, pid: process.pid, startTicks: '1' },
    { ...initial, pidNamespace: 'pid:[9999999]' },
    { ...initial, bootId: '00000000-0000-0000-0000-000000000000', guard: { device: 'old-device', inode: 'old-inode' } },
  ]) {
    writeFileSync(path, JSON.stringify(stale));
    const recovered = store.acquireLease();
    assert.notEqual(JSON.parse(readFileSync(path, 'utf8')).owner, initial.owner);
    assert.throws(() => store.acquireLease(), /already open/);
    recovered();
  }
});

test('malformed metadata and a replaced same-boot guard fail closed without poisoning the fd', linux, (t) => {
  const { store, path } = fixture(t);
  const release = store.acquireLease();
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  release();
  for (const raw of ['{broken', JSON.stringify({ ...metadata, guard: { device: 'changed', inode: 'changed' } })]) {
    writeFileSync(path, raw);
    assert.throws(() => store.acquireLease(), /Cannot verify/);
    assert.equal(readFileSync(path, 'utf8'), raw);
  }
  unlinkSync(path);
  store.acquireLease()();
});

test('missing Linux lock utility fails closed and a later valid constructor can acquire', linux, async (t) => {
  const { directory, store, path } = fixture(t);
  const failed = await holder(directory, { env: { ...process.env, PATH: '/no-roleplay-lock-utility' } });
  assert.equal(failed.result.acquired, false);
  assert.match(failed.result.error, /working flock utility/);
  assert.equal(existsSync(path), false);
  store.acquireLease()();
});

test('SIGKILL releases the real process-owned kernel lock and preserves run evidence', linux, async (t) => {
  const { directory, store, path } = fixture(t);
  const evidence = join(directory, 'completed.json');
  const bytes = '{"id":"completed","status":"completed","evidence":"unchanged"}\n';
  writeFileSync(evidence, bytes);
  const first = await holder(directory);
  t.after(() => { if (first.child.exitCode === null) first.child.kill('SIGKILL'); });
  assert.equal(first.result.acquired, true);
  const previous = readFileSync(path, 'utf8');
  const contender = await holder(directory);
  assert.equal(contender.result.acquired, false);
  assert.match(contender.result.error, /already open/);
  const died = once(first.child, 'exit');
  first.child.kill('SIGKILL');
  await died;
  assert.equal(readFileSync(path, 'utf8'), previous, 'hard kill leaves metadata for recovery');
  const recovered = store.acquireLease();
  assert.equal(readFileSync(evidence, 'utf8'), bytes);
  recovered();
});

test('simultaneous recoverers elect exactly one live owner after a hard kill', linux, async (t) => {
  const { directory } = fixture(t);
  const old = await holder(directory);
  const died = once(old.child, 'exit');
  old.child.kill('SIGKILL'); await died;
  const contenders = await Promise.all(Array.from({ length: 6 }, () => holder(directory)));
  t.after(() => { for (const { child } of contenders) if (child.exitCode === null) child.kill('SIGKILL'); });
  const winners = contenders.filter(({ result }) => result.acquired);
  assert.equal(winners.length, 1);
  for (const { result } of contenders.filter(({ result }) => !result.acquired))
    assert.match(result.error, /already open/);
  const exited = once(winners[0].child, 'exit');
  winners[0].child.send('release'); await exited;
  new RunStore(directory).acquireLease()();
});
