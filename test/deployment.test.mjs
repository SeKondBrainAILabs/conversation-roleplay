import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLab } from '../src/server.mjs';
import { example } from '../src/server.mjs';
import {
  validateManifest,
  deploy,
  deploymentWorkspace,
  verifyWorkspaceContainer,
} from '../deploy/pull-runner.mjs';
import { archiveIdentity } from '../deploy/image-identity.mjs';

const revision = 'a'.repeat(40);
const provenance = {
  repository: 'SeKondBrainAILabs/conversation-roleplay',
  revision,
  runId: '123',
  platform: 'linux/arm64',
  archiveSha256: 'b'.repeat(64),
};

function ownedContainer(workspace = 'conversation-roleplay', port = '4318') {
  return {
    Name: `/${workspace}`,
    Config: {
      Labels: {
        'ai.sekondbrain.roleplay.managed': 'true',
        'com.docker.compose.project': workspace,
        'com.docker.compose.service': 'lab',
      },
    },
    NetworkSettings: {
      Ports: { '4318/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] },
    },
  };
}

test('workspace names remain inside the roleplay namespace', () => {
  assert.equal(deploymentWorkspace({}), 'conversation-roleplay');
  assert.equal(
    deploymentWorkspace({ workspace: 'conversation-roleplay-live' }),
    'conversation-roleplay-live',
  );
  for (const workspace of ['other-app', '../conversation-roleplay', '', '-x', 'conversation-roleplay;stop'])
    assert.throws(() => deploymentWorkspace({ workspace }));
});

test('workspace identity binds the Compose owner and the exact dashboard port', () => {
  const workspace = 'conversation-roleplay-live';
  const dashboard = 'http://127.0.0.1:4319';
  const good = ownedContainer(workspace, '4319');
  verifyWorkspaceContainer(good, workspace, dashboard);
  for (const change of [
    { Name: '/conversation-roleplay' },
    { Config: ownedContainer().Config },
    { NetworkSettings: ownedContainer(workspace, '4318').NetworkSettings },
    { NetworkSettings: { Ports: { '4318/tcp': [{ HostIp: '0.0.0.0', HostPort: '4319' }] } } },
  ])
    assert.throws(() => verifyWorkspaceContainer({ ...good, ...change }, workspace, dashboard));
});
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

for (const workspace of ['conversation-roleplay', 'conversation-roleplay-live'])
test(`${workspace}: failed readiness restores its previous image before releasing the drain`, async () => {
  const port = workspace === 'conversation-roleplay' ? '4318' : '4319';
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
      workspace,
      dashboard: `http://127.0.0.1:${port}`,
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
        if (args[0] === 'container') {
          assert.equal(args[2], workspace);
          return JSON.stringify([
            {
              Image: replaced ? runtimeImageId : previousImage,
              ...ownedContainer(workspace, port),
              State: { Health: { Status: 'healthy' } },
            },
          ]);
        }
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
          assert.equal(args[2], workspace);
          assert.equal(options.env.ROLEPLAY_CONTAINER_NAME, workspace);
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
        assert.equal(new URL(url).port, port);
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

test('a new workspace installs without reading or draining the retained workspace', async () => {
  const workspace = 'conversation-roleplay-live';
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-isolated-install-'));
  const archive = Buffer.from('separate workspace image');
  const imageId = `sha256:${'c'.repeat(64)}`;
  const configDigest = `sha256:${'f'.repeat(64)}`;
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  process.env.ROLEPLAY_TEST_DEPLOY_TOKEN = 'new-workspace-token-'.repeat(3);
  let started = false;
  const paths = [];
  const receipt = await deploy({
    workspace, directory, dashboard: 'http://127.0.0.1:4319',
    deployTokenEnv: 'ROLEPLAY_TEST_DEPLOY_TOKEN', allowInitialInstall: true,
    configFile: '/private/new-workspace/config.json',
    envFile: '/private/new-workspace/services.env', composeFile: '/trusted/compose.yml',
  }, {
    execute(command, args, options = {}) {
      if (command === 'gh') {
        if (args[0] === 'run') {
          const dest = args.at(-1);
          writeFileSync(join(dest, 'image.tar'), archive);
          writeFileSync(join(dest, 'manifest.json'), JSON.stringify({
            version: 2, ...provenance, imageId, imageConfigDigest: configDigest, archiveSha256,
          }));
          return '';
        }
        const path = args[1];
        return JSON.stringify(path.includes('git/ref') ? { object: { sha: revision } }
          : path.includes('artifacts') ? { artifacts: [{
            id: 987, name: 'conversation-roleplay-linux-arm64', expired: false,
            workflow_run: { head_sha: revision },
          }] } : { workflow_runs: [{
            id: 123, head_sha: revision, head_branch: 'main', event: 'push',
            status: 'completed', conclusion: 'success', run_attempt: 1,
            path: '.github/workflows/test.yml',
          }] });
      }
      assert.equal(command, 'docker');
      if (args[0] === 'container') {
        assert.equal(args[2], workspace);
        if (!started) throw new Error('New workspace not installed');
        return JSON.stringify([{ ...ownedContainer(workspace, '4319'), Image: imageId }]);
      }
      if (args[0] === 'image') return JSON.stringify([{
        Id: imageId, Os: 'linux', Architecture: 'arm64', Config: { Labels: {
          'org.opencontainers.image.revision': revision,
          'org.opencontainers.image.source': `https://github.com/${provenance.repository}`,
        } },
      }]);
      if (args[0] === 'compose') {
        assert.equal(args[2], workspace);
        assert.equal(options.env.ROLEPLAY_CONTAINER_NAME, workspace);
        assert.equal(options.env.ROLEPLAY_PORT, '4319');
        assert.equal(options.env.ROLEPLAY_CONFIG_FILE, '/private/new-workspace/config.json');
        started = true;
      }
      return '';
    },
    fetchImpl: async (url) => {
      const u = new URL(url);
      assert.equal(u.port, '4319');
      paths.push(u.pathname);
      assert.notEqual(u.pathname, '/api/deployment/drain');
      return Response.json(u.pathname === '/healthz'
        ? { status: 'ok', revision } : u.pathname === '/readyz' ? { ready: true } : {});
    },
    inspectArchive: () => ({ configDigest }),
  });
  assert.equal(receipt.workspace, workspace);
  assert.equal(receipt.previousImageId, null);
  assert.deepEqual(paths, ['/healthz', '/readyz', '/api/deployment/resume']);
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
