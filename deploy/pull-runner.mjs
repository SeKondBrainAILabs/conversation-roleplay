#!/usr/bin/env node
/** A trusted host-side deployer. It never executes repository workflow scripts or PR jobs on the host. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../src/util.mjs';

export function validateManifest(
  manifest,
  { repository, revision, runId, platform, archiveSha256 },
) {
  assert(
    manifest.version === 1 &&
      manifest.repository === repository &&
      manifest.revision === revision &&
      String(manifest.runId) === String(runId) &&
      manifest.platform === platform,
    'Artifact provenance does not match the successful main build',
  );
  assert(
    /^sha256:[a-f0-9]{64}$/.test(manifest.imageId) &&
      /^[a-f0-9]{64}$/.test(manifest.archiveSha256) &&
      manifest.archiveSha256 === archiveSha256,
    'Artifact checksum/image identity mismatch',
  );
  return manifest;
}

export async function deploy(
  config,
  {
    execute = (command, args, options = {}) =>
      execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
      }).trim(),
    fetchImpl = fetch,
  } = {},
) {
  const {
    repository = 'SeKondBrainAILabs/conversation-roleplay',
    platform = 'linux/arm64',
    workflow = 'test.yml',
  } = config;
  assert(
    /^[\w-]+\/[\w.-]+$/.test(repository) &&
      ['linux/arm64', 'linux/amd64'].includes(platform) &&
      workflow === 'test.yml',
    'Invalid trusted deployment source',
  );
  const directory = resolve(config.directory);
  const base = config.dashboard ?? 'http://127.0.0.1:4318';
  assert(
    /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base),
    'The deploy API must be loopback',
  );
  const deployToken =
    process.env[config.deployTokenEnv ?? 'ROLEPLAY_DEPLOY_TOKEN'];
  assert(deployToken?.length >= 32, 'Configure a private deployment token');
  const composeEnv = {
    ...process.env,
    ROLEPLAY_CONFIG_FILE: resolve(config.configFile),
    ROLEPLAY_ENV_FILE: resolve(config.envFile),
    ROLEPLAY_PORT: new URL(base).port,
  };
  const composeFile = resolve(config.composeFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'runner.lock');
  let fd;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      return {
        status: 'deferred',
        reason:
          'Another deployment owns the lock; inspect a stale lock manually',
      };
    throw error;
  }
  let temp;
  let drained = false;
  let previous;
  const api = (path) =>
    JSON.parse(execute('gh', ['api', `repos/${repository}/${path}`]));
  const docker = (...args) => execute('docker', args);
  const compose = (image, ...args) =>
    execute(
      'docker',
      [
        'compose',
        '--project-name',
        'conversation-roleplay',
        '--file',
        composeFile,
        ...args,
      ],
      { env: { ...composeEnv, ROLEPLAY_IMAGE: image } },
    );
  const control = async (action) => {
    const response = await fetchImpl(`${base}/api/deployment/${action}`, {
      method: 'POST',
      headers: { 'X-Roleplay-Deploy-Token': deployToken },
      signal: AbortSignal.timeout(10000),
    });
    assert(
      response.ok,
      response.status === 409
        ? 'Campaign or uncertain request prevents deployment'
        : 'Deployment control unavailable; no update authorized',
    );
    return response.json();
  };
  try {
    const revision = api('git/ref/heads/main').object.sha;
    assert(/^[a-f0-9]{40}$/.test(revision), 'Invalid main revision');
    const runs = api(
      `actions/workflows/${workflow}/runs?branch=main&event=push&head_sha=${revision}&per_page=20`,
    ).workflow_runs;
    const run = runs.find(
      (item) =>
        item.head_sha === revision &&
        item.head_branch === 'main' &&
        item.event === 'push' &&
        item.status === 'completed' &&
        item.conclusion === 'success' &&
        item.run_attempt === 1 &&
        item.path === `.github/workflows/${workflow}`,
    );
    if (!run)
      return {
        status: 'waiting',
        revision,
        reason: 'Exact main has no successful first-attempt build',
      };
    const receiptPath = join(directory, 'deployment.json');
    let priorReceipt;
    try {
      priorReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    } catch {
      /* First install. */
    }
    try {
      previous = JSON.parse(
        docker('container', 'inspect', 'conversation-roleplay'),
      )[0];
    } catch {
      /* First install must be explicitly allowed. */
    }
    if (previous) {
      assert(
        previous.Config.Labels?.['ai.sekondbrain.roleplay.managed'] === 'true',
        'Refusing to replace an unowned container',
      );
      const health = await (
        await fetchImpl(`${base}/healthz`, {
          signal: AbortSignal.timeout(10000),
        })
      ).json();
      if (
        priorReceipt?.revision === revision &&
        previous.Image === priorReceipt.imageId &&
        health.revision === revision &&
        previous.State.Health?.Status === 'healthy'
      )
        return { status: 'unchanged', revision };
      const stateResponse = await fetchImpl(`${base}/api/deployment-state`, {
        signal: AbortSignal.timeout(10000),
      });
      assert(stateResponse.ok, 'Cannot inspect campaign reservations');
      if (!(await stateResponse.json()).safeToReplace)
        return {
          status: 'deferred',
          reason:
            'Campaign or uncertain request reserves the current container',
        };
    } else
      assert(
        config.allowInitialInstall === true,
        'Initial install must be configured explicitly',
      );
    const artifacts = api(
      `actions/runs/${run.id}/artifacts?per_page=100`,
    ).artifacts.filter(
      (item) =>
        item.name === `conversation-roleplay-${platform.replace('/', '-')}` &&
        !item.expired &&
        item.workflow_run?.head_sha === revision,
    );
    assert(
      artifacts.length === 1,
      'Expected one unexpired image artifact for this exact main build',
    );
    temp = mkdtempSync(join(tmpdir(), 'roleplay-deploy-'));
    execute('gh', [
      'run',
      'download',
      String(run.id),
      '--repo',
      repository,
      '--name',
      artifacts[0].name,
      '--dir',
      temp,
    ]);
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(join(temp, 'image.tar')))
      hash.update(bytes);
    const manifest = validateManifest(
      JSON.parse(readFileSync(join(temp, 'manifest.json'), 'utf8')),
      {
        repository,
        revision,
        runId: run.id,
        platform,
        archiveSha256: hash.digest('hex'),
      },
    );
    docker('load', '--input', join(temp, 'image.tar'));
    const loaded = JSON.parse(docker('image', 'inspect', manifest.imageId))[0];
    assert(
      loaded.Id === manifest.imageId &&
        `${loaded.Os}/${loaded.Architecture}` === platform &&
        loaded.Config.Labels?.['org.opencontainers.image.revision'] ===
          revision &&
        loaded.Config.Labels?.['org.opencontainers.image.source'] ===
          `https://github.com/${repository}`,
      'Loaded image provenance mismatch',
    );
    assert(
      api('git/ref/heads/main').object.sha === revision,
      'Main advanced during staging; wait for the new tested build',
    );
    if (previous) {
      await control('drain');
      drained = true;
    }
    const image = `conversation-roleplay:verified-${revision}`;
    docker('tag', manifest.imageId, image);
    try {
      drained = true;
      compose(
        image,
        'up',
        '--detach',
        '--no-build',
        '--wait',
        '--wait-timeout',
        '90',
        'lab',
      );
      const health = await (
        await fetchImpl(`${base}/healthz`, {
          signal: AbortSignal.timeout(10000),
        })
      ).json();
      assert(
        health.status === 'ok' && health.revision === revision,
        'Deployed revision health mismatch',
      );
      const running = JSON.parse(
        docker('container', 'inspect', 'conversation-roleplay'),
      )[0];
      assert(
        running.Image === manifest.imageId,
        'Running image differs from verified build',
      );
      const readinessResponse = await fetchImpl(`${base}/readyz`, {
        signal: AbortSignal.timeout(45000),
      });
      const readiness = await readinessResponse.json();
      if (config.requireServicesReady !== false)
        assert(
          readinessResponse.ok && readiness.ready,
          'New container shared services are not ready',
        );
      const receipt = {
        status: 'deployed',
        at: new Date().toISOString(),
        repository,
        revision,
        runId: run.id,
        artifactId: artifacts[0].id,
        platform,
        imageId: manifest.imageId,
        archiveSha256: manifest.archiveSha256,
        previousImageId: previous?.Image ?? null,
        readiness,
      };
      writeFileSync(`${receiptPath}.tmp`, JSON.stringify(receipt, null, 2), {
        mode: 0o600,
      });
      const { renameSync } = await import('node:fs');
      renameSync(`${receiptPath}.tmp`, receiptPath);
      return receipt;
    } catch (error) {
      // Both images mount the same durable evidence volume. Drain ensured no campaign was interrupted.
      if (previous) {
        compose(
          previous.Image,
          'up',
          '--detach',
          '--no-build',
          '--wait',
          '--wait-timeout',
          '90',
          'lab',
        );
      }
      throw error;
    }
  } finally {
    if (drained) {
      try {
        await control('resume');
      } catch {
        /* The drain lease also expires after five minutes. */
      }
    }
    if (temp) rmSync(temp, { recursive: true, force: true });
    closeSync(fd);
    unlinkSync(lock);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const config = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
    const result = await deploy(config);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
