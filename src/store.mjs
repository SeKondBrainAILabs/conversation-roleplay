/** Local run artifacts are durable, private and replayable for inspection, never automatic action replay. */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { assert, redact, now, uuid } from './util.mjs';

export class RunStore {
  constructor(directory, { secrets = [] } = {}) {
    this.directory = directory;
    this.secrets = secrets;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  acquireLease() {
    const path = join(this.directory, '.roleplay-lock');
    const owner = uuid();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ owner, pid: process.pid }));
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            if (JSON.parse(readFileSync(path, 'utf8')).owner === owner)
              unlinkSync(path);
          } catch {
            /* Only release this process's lease. */
          }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = JSON.parse(readFileSync(path, 'utf8'));
        assert(
          Number.isInteger(existing.pid) && existing.pid > 0,
          'Cannot verify the run directory owner',
        );
        try {
          process.kill(existing.pid, 0);
        } catch (probe) {
          if (probe.code === 'ESRCH') {
            unlinkSync(path);
            continue;
          }
        }
        throw new Error(
          'This run directory is already open in another process; use its dashboard or a different directory',
        );
      }
    }
    throw new Error('Could not acquire the run directory lease');
  }
  path(id, suffix) {
    assert(/^[\w-]{1,100}$/.test(id), 'Invalid run ID');
    return join(this.directory, `${id}.${suffix}`);
  }
  save(run) {
    const path = this.path(run.id, 'json');
    writeFileSync(
      `${path}.tmp`,
      JSON.stringify(redact(run, this.secrets), null, 2),
      { mode: 0o600 },
    );
    renameSync(`${path}.tmp`, path);
  }
  event(id, event) {
    appendFileSync(
      this.path(id, 'jsonl'),
      JSON.stringify(redact(event, this.secrets)) + '\n',
      { mode: 0o600 },
    );
  }
  read(id) {
    return JSON.parse(readFileSync(this.path(id, 'json'), 'utf8'));
  }
  list() {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        try {
          return [this.read(name.slice(0, -5))];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  recoverInterrupted() {
    for (const run of this.list()) {
      if (!['running', 'paused', 'stopping', 'preparing'].includes(run.status))
        continue;
      run.status = 'interrupted';
      run.finishedAt = now();
      for (const step of run.steps) {
        if (step.inFlight) {
          step.status = 'outcome_unknown';
          step.error =
            'Process stopped with an in-flight request. Inspect saved IDs; do not replay.';
        } else if (['running', 'pending'].includes(step.status))
          step.status = 'blocked';
        if (
          step.repair &&
          ['submitting', 'polling'].includes(step.repair.status)
        )
          step.repair.status = step.repair.providerRunId
            ? 'poll_interrupted'
            : 'submission_unknown';
      }
      this.save(run);
    }
  }
}
