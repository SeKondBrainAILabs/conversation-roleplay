/** Syntax validation without downloading build dependencies. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const walk = (path) =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(path, entry.name))
      : /\.(mjs|js)$/.test(entry.name)
        ? [join(path, entry.name)]
        : [],
  );
for (const file of [
  ...walk('src'),
  ...walk('web'),
  ...walk('test'),
  ...walk('deploy'),
]) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
  });
  if (result.status) process.exit(result.status);
}
console.log('All JavaScript syntax checks passed');
