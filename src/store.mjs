/** Local run artifacts are durable, private and replayable for inspection, never automatic action replay. */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { assert, redact, now } from './util.mjs';
import { acquireRunLease } from './run-lease.mjs';

export class RunStore {
  constructor(directory, { secrets = [] } = {}) {
    this.directory = directory;
    this.secrets = secrets;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  acquireLease() {
    return acquireRunLease(this.directory);
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
        if (step.incident?.status === 'submitting')
          step.incident.status = 'submission_unknown';
        if (step.inFlight) {
          step.status = 'outcome_unknown';
          step.error =
            'Process stopped with an in-flight request. Inspect saved IDs; do not replay.';
        } else if (['running', 'pending'].includes(step.status))
          step.status = 'blocked';
        if (
          step.repair &&
          ['submitting', 'polling', 'answering_clarification'].includes(
            step.repair.status,
          )
        )
          step.repair.status =
            step.repair.status === 'answering_clarification'
              ? 'clarification_submission_unknown'
              : step.repair.providerRunId
                ? 'poll_interrupted'
                : 'submission_unknown';
      }
      this.save(run);
    }
  }
}
