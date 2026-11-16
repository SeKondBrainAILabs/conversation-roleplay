/** Process-owned run-directory exclusion. Never remove the persistent guard inode. */
import {
  constants, openSync, closeSync, fstatSync, statSync, lstatSync,
  readFileSync, writeFileSync, readlinkSync, renameSync, unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const busy = () => new Error(
  'This run directory is already open in another process; use its dashboard or a different directory',
);
const unverifiable = () => new Error(
  'Cannot verify the run directory owner; preserve the lease and verify all prior owners are stopped before manual recovery',
);
const inode = (stat) => ({ device: String(stat.dev), inode: String(stat.ino) });
const sameInode = (a, b) => a.device === b.device && a.inode === b.inode;

function processIdentity() {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = readFileSync('/proc/self/stat', 'utf8');
  // comm can contain spaces and parentheses; fields after its final ')' start at field 3.
  const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const pidNamespace = readlinkSync('/proc/self/ns/pid');
  if (!/^[a-f\d-]{36}$/.test(bootId) || !/^\d+$/.test(startTicks) ||
      !/^pid:\[\d+\]$/.test(pidNamespace)) throw unverifiable();
  return { bootId, startTicks, pidNamespace };
}

function previousLease(path) {
  try {
    if (!lstatSync(path).isFile()) throw unverifiable();
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw unverifiable();
  }
}

export function acquireRunLease(directory) {
  const path = join(directory, '.roleplay-lock');
  const owner = randomUUID();
  // Other platforms retain atomic exclusive-file admission, but never guess that
  // a PID-only or foreign-namespace owner is dead. Linux deployments use flock.
  if (process.platform !== 'linux') {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ version: 2, mechanism: 'exclusive-file', owner, pid: process.pid }));
    } catch (error) {
      if (error.code === 'EEXIST') throw busy();
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return () => {
      try { if (previousLease(path)?.owner === owner) unlinkSync(path); } catch { /* Preserve unverified ownership. */ }
    };
  }

  const guard = join(directory, '.roleplay-kernel-lock');
  let fd;
  let temporary;
  try {
    fd = openSync(guard, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const heldInode = inode(fstatSync(fd));
    // fd 3 is the parent's same open-file description. The short child acquires
    // flock on it; the parent keeps ownership after that child exits. There is
    // no helper whose death could release ownership while this process runs.
    const result = spawnSync('flock', ['-n', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 5000,
    });
    if (!result.error && !result.signal && result.status === 1) throw busy();
    if (result.error || result.signal || result.status !== 0)
      throw new Error('Cannot acquire the run directory kernel lease; a working flock utility is required on Linux');
    if (!sameInode(heldInode, inode(statSync(guard)))) throw unverifiable();
    const identity = processIdentity();
    const previous = previousLease(path);
    if (previous && (
      previous.version !== 2 || previous.mechanism !== 'kernel-flock' ||
      typeof previous.owner !== 'string' || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 ||
      !/^[a-f\d-]{36}$/.test(previous.bootId ?? '') || !/^\d+$/.test(previous.startTicks ?? '') ||
      !/^pid:\[\d+\]$/.test(previous.pidNamespace ?? '') ||
      !previous.guard || typeof previous.guard.device !== 'string' || typeof previous.guard.inode !== 'string' ||
      (previous.bootId === identity.bootId && !sameInode(previous.guard, heldInode))
    )) throw unverifiable();
    // Holding the same kernel lock proves no versioned owner is alive, even
    // across PID namespaces or PID reuse. Old PID-only leases remain fail-closed.
    const lease = { version: 2, mechanism: 'kernel-flock', owner, pid: process.pid, ...identity, guard: heldInode };
    temporary = join(directory, `.roleplay-lock.${owner}.tmp`);
    writeFileSync(temporary, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    temporary = undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        if (sameInode(heldInode, inode(statSync(guard))) && previousLease(path)?.owner === owner)
          unlinkSync(path);
      } catch { /* Preserve changed or unreadable lease metadata. */ }
      finally { closeSync(fd); }
    };
  } catch (error) {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Preserve unrelated files. */ } }
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
}
