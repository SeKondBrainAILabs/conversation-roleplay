#!/usr/bin/env node
/** Pin reviewed deployment code and a workflow allowlist outside the runner work directory. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert } from '../src/util.mjs';

const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
const git = (...args) =>
  execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
assert(
  !git('status', '--porcelain'),
  'Install only from a clean reviewed checkout',
);
const revision = git('rev-parse', 'HEAD');
const root = join(homedir(), '.local/share/conversation-roleplay');
const directory = join(root, 'sddmini');
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const trusted = join(root, 'trusted', revision);
if (!existsSync(trusted)) {
  mkdirSync(trusted, { recursive: true, mode: 0o700 });
  const archive = execFileSync('git', ['-C', source, 'archive', revision], {
    maxBuffer: 16 * 1024 * 1024,
  });
  execFileSync('tar', ['-xf', '-', '-C', trusted], { input: archive });
}
const config = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
assert(
  config.repository === 'SeKondBrainAILabs/conversation-roleplay',
  'Wrong repository',
);
const repositoryId = JSON.parse(
  execFileSync('gh', ['api', `repos/${config.repository}`], {
    encoding: 'utf8',
    timeout: 20000,
  }),
).id;
const policy = {
  repository: config.repository,
  repositoryId,
  sourceBranch: 'SDDMiniFeet',
  trustedRevision: revision,
  workflowSha256: createHash('sha256')
    .update(
      readFileSync(join(trusted, '.github/workflows/sddmini-release.yml')),
    )
    .digest('hex'),
};
const writePrivate = (name, body, mode = 0o600) => {
  const path = join(directory, name);
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
  return path;
};
writePrivate('policy.json', JSON.stringify(policy, null, 2));
writePrivate(
  'config.json',
  JSON.stringify(
    {
      ...config,
      sourceBranch: 'SDDMiniFeet',
      requireReleaseTag: true,
      composeFile: join(trusted, 'deploy/compose.yml'),
      allowInitialInstall: false,
    },
    null,
    2,
  ),
);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
writePrivate(
  'guard.sh',
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(trusted, 'deploy/sddmini-guard.mjs'))} ${quote(join(directory, 'policy.json'))}\n`,
  0o700,
);
writePrivate(
  'run-release.mjs',
  `import { runRelease } from ${JSON.stringify(pathToFileURL(join(trusted, 'deploy/run-sddmini.mjs')).href)};\ntry { await runRelease(${JSON.stringify(join(directory, 'config.json'))}, ${JSON.stringify(join(directory, 'policy.json'))}); } catch (error) { console.error(error.message); process.exitCode = 1; }\n`,
);
console.log(
  `Pinned SDDMini deployment code at ${revision}. Configure ACTIONS_RUNNER_HOOK_JOB_STARTED=${join(directory, 'guard.sh')} in the dedicated runner service environment before starting it.`,
);
