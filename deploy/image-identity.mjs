/** Classic Docker reports a config ID; containerd may report an OCI manifest ID.
 * The saved configuration digest, including rootfs diff IDs, is portable across both. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assert } from '../src/util.mjs';

export function archiveIdentity(path, expectedTag) {
  const extract = (member) =>
    execFileSync('tar', ['-xOf', path, member], { maxBuffer: 4000000 });
  const entries = JSON.parse(extract('manifest.json').toString('utf8'));
  assert(
    Array.isArray(entries) &&
      entries.length === 1 &&
      entries[0].RepoTags?.length === 1 &&
      entries[0].RepoTags[0] === expectedTag,
    'Archive must contain exactly the expected roleplay image',
  );
  const configPath = entries[0].Config;
  assert(
    /^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(configPath),
    'Unsafe image configuration path',
  );
  const bytes = extract(configPath);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert(
    configPath.includes(digest.slice(7)),
    'Image configuration filename/digest mismatch',
  );
  return { configDigest: digest, config: JSON.parse(bytes.toString('utf8')) };
}
