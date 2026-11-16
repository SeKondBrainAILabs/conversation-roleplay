/** Isolated native Docker proof: shared volume exclusion, hard death and restart. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assert, sleep } from '../src/util.mjs';

const nativeDocker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
}).trim();

export async function qualifyContainerLease(image, { docker = nativeDocker } = {}) {
  const volume = `roleplay-lease-proof-${randomUUID()}`;
  const containers = [];
  const program = `import {RunStore} from '/app/src/store.mjs';
    new RunStore('/data/runs').acquireLease();
    console.log('lease-ready');setInterval(()=>{},1000);`;
  const args = ['--init', '--network', 'none', '--read-only', '--mount',
    `type=volume,source=${volume},target=/data/runs`, '--entrypoint', 'node'];
  const read = (container) => JSON.parse(docker('exec', container, 'node', '-e',
    `console.log(require('fs').readFileSync('/data/runs/.roleplay-lock','utf8'))`));
  const wait = async (container, previousOwner) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const lease = read(container);
        if (lease.owner && lease.owner !== previousOwner) return lease;
      } catch { /* Wait for this isolated process to acquire. */ }
      await sleep(100);
    }
    throw new Error('Isolated container did not acquire its run lease');
  };
  docker('volume', 'create', volume);
  try {
    const first = docker('run', '--detach', ...args, image, '--input-type=module', '-e', program);
    containers.push(first);
    const original = await wait(first);
    assert(original.mechanism === 'kernel-flock', 'Container must use kernel ownership');
    docker('exec', first, 'node', '-e',
      `require('fs').writeFileSync('/data/runs/archived.json','{"status":"completed","evidence":"unchanged"}\\n')`);
    const evidence = (container) => docker('exec', container, 'node', '-e',
      `console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/data/runs/archived.json')).digest('hex'))`);
    const before = evidence(first);
    let refused = false;
    // Record a name before invoking the client: a timed-out docker run can leave
    // the container alive, including precisely when exclusion regresses.
    const contender = `roleplay-lease-contender-${randomUUID()}`;
    containers.push(contender);
    try { docker('run', '--name', contender, '--rm', ...args, image, '--input-type=module', '-e', program); }
    catch (error) { refused = error.status === 1 && String(error.stderr).includes('already open in another process'); }
    assert(refused, 'A second container must not steal the shared volume');
    docker('kill', '--signal', 'KILL', first);
    docker('start', first);
    const restarted = await wait(first, original.owner);
    assert(restarted.pid === original.pid, 'Native restart must exercise the same reused PID');
    assert(evidence(first) === before, 'Restart must preserve archived evidence');
    assert(JSON.stringify(restarted.guard) === JSON.stringify(original.guard), 'Guard inode must survive restart');
    docker('kill', '--signal', 'KILL', first);
    const replacement = docker('run', '--detach', ...args, image, '--input-type=module', '-e', program);
    containers.push(replacement);
    const recovered = await wait(replacement, restarted.owner);
    assert(evidence(replacement) === before, 'A replacement container must preserve evidence');
    assert(JSON.stringify(recovered.guard) === JSON.stringify(original.guard), 'Replacement must retain the same guard inode');
    return { sharedVolumeContention: 'passed', hardKillRestart: 'passed', replacementContainer: 'passed',
      evidencePreserved: true, reusedPid: restarted.pid === original.pid, kernelOwner: 'node-process' };
  } finally {
    for (const container of containers) { try { docker('rm', '--force', container); } catch { /* Continue owned cleanup. */ } }
    docker('volume', 'rm', volume);
  }
}
