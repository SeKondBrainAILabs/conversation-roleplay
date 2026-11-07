import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeRelease } from '../deploy/sddmini-guard.mjs';
import { deploy } from '../deploy/pull-runner.mjs';

const repository = 'SeKondBrainAILabs/conversation-roleplay';
const revision = 'a'.repeat(40);
const workflow = '.github/workflows/sddmini-release.yml';
const workflowText = 'reviewed workflow bytes';
const tagName = 'SDDMini-KF/v0.1.0';
const policy = {
  repository,
  repositoryId: 123,
  sourceBranch: 'SDDMiniFeet',
  workflowSha256: createHash('sha256').update(workflowText).digest('hex'),
};
const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_REPOSITORY_ID: '123',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF_TYPE: 'tag',
  GITHUB_REF: `refs/tags/${tagName}`,
  GITHUB_WORKFLOW_REF: `${repository}/${workflow}@refs/tags/${tagName}`,
  GITHUB_JOB: 'deploy',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_RUN_ID: '456',
  GITHUB_SHA: revision,
  GITHUB_WORKFLOW_SHA: revision,
};
const api = (path) => {
  if (path.startsWith('actions/runs/'))
    return {
      head_sha: revision,
      event: 'push',
      path: workflow,
      run_attempt: 1,
      repository: { full_name: repository },
    };
  if (path.startsWith('git/ref/tags/'))
    return { object: { type: 'tag', sha: 'b'.repeat(40) } };
  if (path.startsWith('git/tags/'))
    return { object: { type: 'commit', sha: revision } };
  if (path.startsWith('git/ref/heads/')) return { object: { sha: revision } };
  if (path.startsWith('contents/'))
    return {
      encoding: 'base64',
      content: Buffer.from(workflowText).toString('base64'),
    };
  throw new Error(`Unexpected API path ${path}`);
};

test('Feet runner accepts only the host-reviewed annotated release at the source branch head', () => {
  assert.deepEqual(authorizeRelease(policy, env, api), {
    repository,
    revision,
    releaseTag: tagName,
    releaseRunId: '456',
    sourceBranch: 'SDDMiniFeet',
  });
});

test('Feet runner rejects PRs, branches, foreign repositories, other workflows and reruns before any API access', () => {
  for (const change of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REPOSITORY: 'attacker/fork' },
    { GITHUB_REPOSITORY_ID: '999' },
    { GITHUB_REF_TYPE: 'branch' },
    { GITHUB_REF: 'refs/heads/SDDMiniFeet' },
    { GITHUB_REF: 'refs/tags/SDDMini-KF/arbitrary' },
    {
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/test.yml@${env.GITHUB_REF}`,
    },
    { GITHUB_JOB: 'test' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) },
  ])
    assert.throws(() =>
      authorizeRelease(policy, { ...env, ...change }, () =>
        assert.fail('API must not run'),
      ),
    );
});

test('Feet runner rejects lightweight or moved tags, advanced branches, modified workflow bytes and run spoofing', () => {
  for (const [prefix, replacement] of [
    ['git/ref/tags/', { object: { type: 'commit', sha: revision } }],
    ['git/tags/', { object: { type: 'commit', sha: 'c'.repeat(40) } }],
    ['git/ref/heads/', { object: { sha: 'c'.repeat(40) } }],
    [
      'contents/',
      {
        encoding: 'base64',
        content: Buffer.from('malicious steps').toString('base64'),
      },
    ],
    ['actions/runs/', { ...api('actions/runs/456'), event: 'pull_request' }],
    ['actions/runs/', { ...api('actions/runs/456'), run_attempt: 2 }],
  ])
    assert.throws(() =>
      authorizeRelease(policy, env, (path) =>
        path.startsWith(prefix) ? replacement : api(path),
      ),
    );
});

test('tagged deployment refuses missing or mismatched release before Docker or artifact downloads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-release-'));
  process.env.ROLEPLAY_TEST_DEPLOY_TOKEN = 'deployment-private-'.repeat(3);
  const config = {
    repository,
    sourceBranch: 'SDDMiniFeet',
    requireReleaseTag: true,
    directory,
    deployTokenEnv: 'ROLEPLAY_TEST_DEPLOY_TOKEN',
    configFile: '/tmp/config',
    envFile: '/tmp/env',
    composeFile: '/tmp/compose',
  };
  await assert.rejects(deploy(config), /Invalid trusted deployment source/);
  await assert.rejects(
    deploy(
      { ...config, releaseTag: tagName },
      {
        execute: (command, args) => {
          assert.equal(command, 'gh');
          const path = args[1].slice(`repos/${repository}/`.length);
          return JSON.stringify(
            path.startsWith('git/tags/')
              ? { object: { type: 'commit', sha: 'c'.repeat(40) } }
              : api(path),
          );
        },
      },
    ),
    /not the current source branch/,
  );
  assert.equal(existsSync(join(directory, 'runner.lock')), false);
  delete process.env.ROLEPLAY_TEST_DEPLOY_TOKEN;
});

test('tagged deployment requires the successful exact source-branch push build', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-release-build-'));
  process.env.ROLEPLAY_TEST_DEPLOY_TOKEN = 'deployment-private-'.repeat(3);
  const result = await deploy(
    {
      repository,
      sourceBranch: 'SDDMiniFeet',
      releaseTag: tagName,
      expectedRevision: revision,
      requireReleaseTag: true,
      directory,
      deployTokenEnv: 'ROLEPLAY_TEST_DEPLOY_TOKEN',
      configFile: '/tmp/config',
      envFile: '/tmp/env',
      composeFile: '/tmp/compose',
    },
    {
      execute: (command, args) => {
        assert.equal(command, 'gh');
        const path = args[1].slice(`repos/${repository}/`.length);
        if (path.startsWith('actions/workflows/')) {
          assert.match(path, /branch=SDDMiniFeet&event=push&head_sha=/);
          return JSON.stringify({
            workflow_runs: [
              {
                id: 123,
                head_sha: revision,
                head_branch: 'main',
                event: 'push',
                status: 'completed',
                conclusion: 'success',
                run_attempt: 1,
                path: '.github/workflows/test.yml',
              },
            ],
          });
        }
        return JSON.stringify(api(path));
      },
    },
  );
  assert.equal(result.status, 'waiting');
  assert.equal(existsSync(join(directory, 'runner.lock')), false);
  delete process.env.ROLEPLAY_TEST_DEPLOY_TOKEN;
});
