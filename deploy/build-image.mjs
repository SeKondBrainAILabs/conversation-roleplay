/** Hosted CI only: build a native image, smoke it, and export an immutable deploy artifact. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { get } from 'node:http';
import { assert, sleep } from '../src/util.mjs';
import { archiveIdentity } from './image-identity.mjs';

const revision = process.env.GITHUB_SHA;
const runId = process.env.GITHUB_RUN_ID;
assert(
  /^[a-f0-9]{40}$/.test(revision) && /^\d+$/.test(runId),
  'CI revision/run identity required',
);
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
// Node fetch may replace Host with the mapped ephemeral port. Use the native client
// so the probe preserves the same Host/Origin boundary as the published dashboard.
const readJson = (url) =>
  new Promise((resolve, reject) => {
    const request = get(
      url,
      { headers: { Host: '127.0.0.1:4318' }, timeout: 2000 },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 10000)
            request.destroy(new Error('Oversized smoke response'));
        });
        response.on('end', () => {
          try {
            assert(response.statusCode === 200, 'Container smoke HTTP failure');
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error('Container smoke timeout')),
    );
    request.on('error', reject);
  });
const architecture = docker('info', '--format', '{{.Architecture}}');
const arch = ['aarch64', 'arm64'].includes(architecture)
  ? 'arm64'
  : architecture === 'x86_64'
    ? 'amd64'
    : architecture;
assert(['arm64', 'amd64'].includes(arch), 'Unsupported Docker architecture');
const platform = `linux/${arch}`;
const image = `conversation-roleplay:ci-${revision}`;
docker('build', '--build-arg', `VCS_REF=${revision}`, '--tag', image, '.');
const imageId = docker('image', 'inspect', image, '--format', '{{.Id}}');
const container = docker(
  'run',
  '--detach',
  '--init',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--env',
  'ROLEPLAY_RUNS_DIR=/tmp/runs',
  '--publish',
  '127.0.0.1::4318',
  image,
);
try {
  const port = docker('port', container, '4318/tcp').split(':').at(-1);
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const health = await readJson(`http://127.0.0.1:${port}/healthz`);
      healthy = health.status === 'ok' && health.revision === revision;
    } catch {
      /* Wait for Node startup. */
    }
    if (healthy) break;
    await sleep(500);
  }
  assert(healthy, 'Container health/revision smoke failed');
  const readiness = await readJson(`http://127.0.0.1:${port}/readyz`);
  assert(
    readiness.ready && readiness.mode === 'demo-or-custom',
    'Offline container must remain usable',
  );
} finally {
  docker('rm', '--force', '--volumes', container);
}
const output = resolve('image-artifact');
mkdirSync(output, { recursive: true });
const archive = join(output, 'image.tar');
docker('save', '--output', archive, image);
const { configDigest } = archiveIdentity(archive, image);
const hash = createHash('sha256');
for await (const bytes of createReadStream(archive)) hash.update(bytes);
writeFileSync(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      version: 2,
      repository: process.env.GITHUB_REPOSITORY,
      revision,
      runId,
      platform,
      imageId,
      imageConfigDigest: configDigest,
      archiveSha256: hash.digest('hex'),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ revision, platform, imageId, containerSmoke: 'passed' }),
);
