import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLab } from '../src/server.mjs';
import { example } from '../src/server.mjs';
import { validateManifest, deploy } from '../deploy/pull-runner.mjs';
import { archiveIdentity } from '../deploy/image-identity.mjs';

const revision = 'a'.repeat(40);
const provenance = {
  repository: 'SeKondBrainAILabs/conversation-roleplay',
  revision,
  runId: '123',
  platform: 'linux/arm64',
  archiveSha256: 'b'.repeat(64),
};
test('deployment rejects wrong commit, run, architecture and corrupted archives', () => {
  const manifest = {
    version: 2,
    ...provenance,
    imageId: `sha256:${'c'.repeat(64)}`,
    imageConfigDigest: `sha256:${'f'.repeat(64)}`,
  };
  assert.equal(validateManifest(manifest, provenance), manifest);
  for (const change of [
    { revision: 'd'.repeat(40) },
    { runId: '456' },
    { platform: 'linux/amd64' },
    { archiveSha256: 'e'.repeat(64) },
    { imageId: 'arbitrary-tag' },
    { imageConfigDigest: 'unverified-config' },
  ])
    assert.throws(() =>
      validateManifest({ ...manifest, ...change }, provenance),
    );
});

test('pull runner ignores PR and incomplete builds without touching Docker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-pull-'));
  process.env.ROLEPLAY_TEST_DEPLOY_TOKEN = 'private-token-'.repeat(4);
  const commands = [];
  const result = await deploy(
    {
      directory,
      deployTokenEnv: 'ROLEPLAY_TEST_DEPLOY_TOKEN',
      configFile: '/tmp/config',
      envFile: '/tmp/env',
      composeFile: '/tmp/compose',
    },
    {
      execute: (command, args) => {
        commands.push(command);
        assert.equal(command, 'gh');
        return JSON.stringify(
          args[1].includes('git/ref')
            ? { object: { sha: revision } }
            : {
                workflow_runs: [
                  {
                    head_sha: revision,
                    head_branch: 'main',
                    event: 'pull_request',
                    status: 'completed',
                    conclusion: 'success',
                    run_attempt: 1,
                    path: '.github/workflows/test.yml',
                  },
                ],
              },
        );
      },
    },
  );
  assert.equal(result.status, 'waiting');
  assert.deepEqual(commands, ['gh', 'gh']);
  assert.equal(existsSync(join(directory, 'runner.lock')), false);
  delete process.env.ROLEPLAY_TEST_DEPLOY_TOKEN;
});

test('deployment drain is independently authenticated and blocks campaign starts', async (t) => {
  const token = 'deployment-secret-'.repeat(3);
  const lab = createLab(
    {},
    {
      directory: mkdtempSync(join(tmpdir(), 'roleplay-drain-')),
      env: { ROLEPLAY_DEPLOY_TOKEN: token },
    },
  );
  await new Promise((resolve) => lab.server.listen(0, '127.0.0.1', resolve));
  t.after(() => lab.server.close());
  const base = `http://127.0.0.1:${lab.server.address().port}`;
  const meta = await (await fetch(base + '/api/meta')).json();
  const control = (headers) =>
    fetch(base + '/api/deployment/drain', { method: 'POST', headers });
  assert.equal((await control({ 'X-Roleplay-Token': meta.csrf })).status, 400);
  assert.equal(
    (await control({ 'X-Roleplay-Deploy-Token': token })).status,
    200,
  );
  await assert.rejects(lab.launch(example()), /draining/);
  assert.equal(
    (
      await fetch(base + '/api/runs', {
        method: 'POST',
        headers: { 'X-Roleplay-Token': meta.csrf },
        body: JSON.stringify(example()),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(base + '/api/deployment/resume', {
        method: 'POST',
        headers: { 'X-Roleplay-Deploy-Token': token },
      })
    ).status,
    200,
  );
  lab.store.save({
    id: 'uncertain',
    startedAt: new Date().toISOString(),
    status: 'interrupted',
    steps: [{ status: 'outcome_unknown' }],
  });
  assert.equal(
    (await control({ 'X-Roleplay-Deploy-Token': token })).status,
    409,
  );
  const state = await (await fetch(base + '/api/deployment-state')).json();
  assert.equal(state.safeToReplace, false);
  assert.equal(state.uncertain, 1);
});

test('failed post-cutover readiness restores the previous image before releasing the drain', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-rollback-'));
  process.env.ROLEPLAY_TEST_DEPLOY_TOKEN = 'deployment-private-'.repeat(3);
  const imageId = `sha256:${'c'.repeat(64)}`;
  const runtimeImageId = `sha256:${'9'.repeat(64)}`;
  const previousImage = `sha256:${'d'.repeat(64)}`;
  const archive = Buffer.from('controlled image archive');
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const operations = [];
  let replaced = false;
  const result = deploy(
    {
      directory,
      deployTokenEnv: 'ROLEPLAY_TEST_DEPLOY_TOKEN',
      configFile: '/tmp/config',
      envFile: '/tmp/env',
      composeFile: '/tmp/compose',
    },
    {
      execute: (command, args, options) => {
        if (command === 'gh') {
          if (args[0] === 'run') {
            const output = args[args.indexOf('--dir') + 1];
            writeFileSync(join(output, 'image.tar'), archive);
            writeFileSync(
              join(output, 'manifest.json'),
              JSON.stringify({
                version: 2,
                ...provenance,
                imageId,
                imageConfigDigest: `sha256:${'f'.repeat(64)}`,
                archiveSha256,
              }),
            );
            return '';
          }
          const path = args[1];
          return JSON.stringify(
            path.includes('git/ref')
              ? { object: { sha: revision } }
              : path.includes('artifacts')
                ? {
                    artifacts: [
                      {
                        id: 987,
                        name: 'conversation-roleplay-linux-arm64',
                        expired: false,
                        workflow_run: { head_sha: revision },
                      },
                    ],
                  }
                : {
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
                  },
          );
        }
        assert.equal(command, 'docker');
        if (args[0] === 'container')
          return JSON.stringify([
            {
              Image: replaced ? runtimeImageId : previousImage,
              Config: { Labels: { 'ai.sekondbrain.roleplay.managed': 'true' } },
              State: { Health: { Status: 'healthy' } },
            },
          ]);
        if (args[0] === 'image')
          return JSON.stringify([
            {
              Id: runtimeImageId,
              Os: 'linux',
              Architecture: 'arm64',
              Config: {
                Labels: {
                  'org.opencontainers.image.revision': revision,
                  'org.opencontainers.image.source': `https://github.com/${provenance.repository}`,
                },
              },
            },
          ]);
        if (args[0] === 'compose') {
          operations.push(
            options.env.ROLEPLAY_IMAGE === previousImage
              ? 'rollback'
              : 'replace',
          );
          replaced = options.env.ROLEPLAY_IMAGE !== previousImage;
        }
        return '';
      },
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/drain')) operations.push('drain');
        if (path.endsWith('/resume')) operations.push('resume');
        const body =
          path === '/healthz'
            ? { status: 'ok', revision: replaced ? revision : 'previous' }
            : path === '/readyz'
              ? { ready: false }
              : { safeToReplace: true };
        return new Response(JSON.stringify(body), {
          status: path === '/readyz' ? 503 : 200,
        });
      },
      inspectArchive: () => ({ configDigest: `sha256:${'f'.repeat(64)}` }),
    },
  );
  await assert.rejects(result, /shared services are not ready/);
  assert.deepEqual(operations, ['drain', 'replace', 'rollback', 'resume']);
  assert.equal(existsSync(join(directory, 'deployment.json')), false);
  assert.equal(existsSync(join(directory, 'runner.lock')), false);
  delete process.env.ROLEPLAY_TEST_DEPLOY_TOKEN;
});

test('classic and OCI archive layouts preserve the same portable config identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-image-identity-'));
  const bytes = JSON.stringify({
    architecture: 'arm64',
    os: 'linux',
    config: { Labels: { 'org.opencontainers.image.revision': revision } },
    rootfs: { type: 'layers', diff_ids: [`sha256:${'b'.repeat(64)}`] },
  });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const tag = `conversation-roleplay:ci-${revision}`;
  for (const member of [`${digest}.json`, `blobs/sha256/${digest}`]) {
    mkdirSync(join(directory, 'blobs/sha256'), { recursive: true });
    writeFileSync(join(directory, member), bytes);
    writeFileSync(
      join(directory, 'manifest.json'),
      JSON.stringify([{ Config: member, RepoTags: [tag], Layers: [] }]),
    );
    const tar = join(directory, 'image.tar');
    execFileSync('tar', ['-cf', tar, '-C', directory, 'manifest.json', member]);
    assert.equal(archiveIdentity(tar, tag).configDigest, `sha256:${digest}`);
    assert.throws(
      () => archiveIdentity(tar, 'unexpected:tag'),
      /exactly the expected/,
    );
    writeFileSync(join(directory, member), bytes + ' ');
    execFileSync('tar', ['-cf', tar, '-C', directory, 'manifest.json', member]);
    assert.throws(() => archiveIdentity(tar, tag), /digest mismatch/);
  }
});
