/** Fail closed before a dedicated public-repository runner executes any job step. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../src/util.mjs';

export function authorizeRelease(
  policy,
  env = process.env,
  api = (path) =>
    JSON.parse(
      execFileSync('gh', ['api', `repos/${policy.repository}/${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      }),
    ),
) {
  const { repository, repositoryId, workflowSha256, sourceBranch } = policy;
  const workflow = '.github/workflows/sddmini-release.yml';
  assert(
    repository === 'SeKondBrainAILabs/conversation-roleplay' &&
      sourceBranch === 'SDDMiniFeet' &&
      /^[a-f0-9]{64}$/.test(workflowSha256),
    'Invalid host release policy',
  );
  assert(
    env.GITHUB_REPOSITORY === repository &&
      String(env.GITHUB_REPOSITORY_ID) === String(repositoryId),
    'Wrong repository',
  );
  assert(
    env.GITHUB_EVENT_NAME === 'push' &&
      env.GITHUB_REF_TYPE === 'tag' &&
      /^refs\/tags\/SDDMini-KF\/v\d+\.\d+\.\d+$/.test(env.GITHUB_REF),
    'Only versioned Feet tag pushes may use this runner',
  );
  assert(
    env.GITHUB_WORKFLOW_REF === `${repository}/${workflow}@${env.GITHUB_REF}` &&
      env.GITHUB_JOB === 'deploy',
    'Unapproved workflow or job',
  );
  assert(
    env.GITHUB_RUN_ATTEMPT === '1' &&
      /^\d+$/.test(env.GITHUB_RUN_ID) &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA) &&
      env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA,
    'Invalid or repeated release run',
  );
  const run = api(`actions/runs/${env.GITHUB_RUN_ID}`);
  assert(
    run.head_sha === env.GITHUB_SHA &&
      run.event === 'push' &&
      run.path === workflow &&
      run.run_attempt === 1 &&
      run.repository?.full_name === repository,
    'Release run provenance mismatch',
  );
  const tagName = env.GITHUB_REF.slice('refs/tags/'.length);
  const ref = api(`git/ref/tags/${tagName}`);
  assert(ref.object?.type === 'tag', 'Only annotated releases are allowed');
  const tag = api(`git/tags/${ref.object.sha}`);
  assert(
    tag.object?.type === 'commit' &&
      tag.object.sha === env.GITHUB_SHA &&
      api(`git/ref/heads/${sourceBranch}`).object.sha === env.GITHUB_SHA,
    'Release does not match the source branch',
  );
  const file = api(`contents/${workflow}?ref=${env.GITHUB_WORKFLOW_SHA}`);
  assert(
    file.encoding === 'base64' &&
      createHash('sha256')
        .update(Buffer.from(file.content, 'base64'))
        .digest('hex') === workflowSha256,
    'Workflow differs from the host-reviewed deployment workflow',
  );
  return {
    repository,
    revision: env.GITHUB_SHA,
    releaseTag: tagName,
    releaseRunId: env.GITHUB_RUN_ID,
    sourceBranch,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = authorizeRelease(
      JSON.parse(readFileSync(process.argv[2], 'utf8')),
    );
    console.log(`Authorized ${result.releaseTag} at ${result.revision}`);
  } catch (error) {
    console.error(`Runner refused job: ${error.message}`);
    process.exitCode = 1;
  }
}
