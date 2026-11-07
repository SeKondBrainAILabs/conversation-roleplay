/** Installed from a reviewed checkout, never executed from an Actions checkout. */
import { readFileSync } from 'node:fs';
import { authorizeRelease } from './sddmini-guard.mjs';
import { deploy } from './pull-runner.mjs';

export async function runRelease(configPath, policyPath) {
  const authorized = authorizeRelease(
    JSON.parse(readFileSync(policyPath, 'utf8')),
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  process.loadEnvFile(config.envFile);
  const result = await deploy({
    ...config,
    ...authorized,
    expectedRevision: authorized.revision,
    requireReleaseTag: true,
  });
  if (!['deployed', 'unchanged'].includes(result.status))
    throw new Error(`Release ${result.status}: ${result.reason}`);
  const {
    status,
    revision,
    releaseTag,
    runId,
    platform,
    imageId,
    imageConfigDigest,
  } = result;
  console.log(
    JSON.stringify({
      status,
      revision,
      releaseTag,
      runId,
      platform,
      imageId,
      imageConfigDigest,
    }),
  );
  return result;
}
