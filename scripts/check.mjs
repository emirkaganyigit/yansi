import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collect(location));
    else if (/\.(?:js|cjs|mjs|sh)$/.test(entry.name)) result.push(location);
  }
  return result;
}
let failed = false;
for (const file of [...await collect('src'), ...await collect('scripts'), ...await collect('tests')]) {
  const result = file.endsWith('.sh')
    ? spawnSync('bash', ['-n', file], { encoding: 'utf8' })
    : spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; console.error(result.stderr); }
}
if (failed) process.exitCode = 1;
else console.log('JavaScript ve Bash sözdizimi kontrolleri geçti.');
