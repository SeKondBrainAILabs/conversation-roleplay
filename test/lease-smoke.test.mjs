import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyContainerLease } from '../deploy/lease-smoke.mjs';

for (const failure of ['unexpected admission', 'client timeout']) {
  test(`container qualification cleans its named contender after ${failure}`, async () => {
    const calls = [];
    let contender;
    const docker = (...args) => {
      calls.push(args);
      if (args[0] === 'run' && args.includes('--detach')) return 'isolated-owner';
      if (args[0] === 'run' && args.includes('--name')) {
        contender = args[args.indexOf('--name') + 1];
        if (failure === 'client timeout') throw Object.assign(new Error('client timeout'), { status: null });
        return '';
      }
      if (args[0] === 'exec' && args.at(-1).includes('.roleplay-lock'))
        return JSON.stringify({ owner: 'original', mechanism: 'kernel-flock' });
      if (args[0] === 'exec' && args.at(-1).includes('createHash')) return 'unchanged-evidence';
      return '';
    };
    await assert.rejects(qualifyContainerLease('isolated-test-image', { docker }), /must not steal/);
    assert.match(contender, /^roleplay-lease-contender-/);
    assert.ok(calls.some((args) => args[0] === 'rm' && args.includes('isolated-owner')));
    assert.ok(calls.some((args) => args[0] === 'rm' && args.includes(contender)));
    assert.equal(calls.at(-1)[0], 'volume');
    assert.equal(calls.at(-1)[1], 'rm');
  });
}
