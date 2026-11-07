#!/usr/bin/env node
/** Install a per-user pull deployment runner on macOS. All host paths remain local. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert } from '../src/util.mjs';

const configPath = resolve(process.argv[2]);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const runner = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'pull-runner.mjs',
);
const directory = resolve(config.directory);
assert(directory !== '/', 'Use a dedicated deployment directory');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const agents = join(homedir(), 'Library/LaunchAgents');
mkdirSync(agents, { recursive: true });
const label = 'ai.sekondbrain.conversation-roleplay.deploy';
const plist = join(agents, `${label}.plist`);
const xml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const args = [
  process.execPath,
  `--env-file=${resolve(config.envFile)}`,
  runner,
  configPath,
];
writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>StartInterval</key><integer>300</integer><key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(dirname(process.execPath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>StandardOutPath</key><string>${xml(join(directory, 'runner.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(directory, 'runner-error.log'))}</string>
</dict></plist>`,
  { mode: 0o600 },
);
chmodSync(plist, 0o600);
for (const name of ['runner.log', 'runner-error.log']) {
  writeFileSync(join(directory, name), '', { flag: 'a', mode: 0o600 });
  chmodSync(join(directory, name), 0o600);
}
const domain = `gui/${process.getuid()}`;
try {
  execFileSync('launchctl', ['bootout', `${domain}/${label}`], {
    stdio: 'ignore',
  });
} catch {
  /* Initial install. */
}
execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
console.log(
  `Installed ${label}; checks main every five minutes. Logs: ${directory}`,
);
