import { cp, mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const name = `yansi-${process.platform}-${process.arch}`;
const destination = path.join(output, name);
const appDirectory = path.join(destination, 'resources/app');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await mkdir(output, { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(path.join(root, 'node_modules/electron/dist'), destination, { recursive: true });
await mkdir(appDirectory, { recursive: true });
for (const directory of ['src', 'assets']) await cp(path.join(root, directory), path.join(appDirectory, directory), { recursive: true });
await cp(path.join(root, 'node_modules/ws'), path.join(appDirectory, 'node_modules/ws'), { recursive: true });
await writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ ...manifest, devDependencies: undefined, scripts: undefined }, null, 2) + '\n');
await cp(path.join(root, 'README.md'), path.join(destination, 'README.md'));
await cp(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE.yansi'));
await cp(path.join(root, 'assets/icon.png'), path.join(destination, 'icon.png'));
for (const script of ['install.sh', 'uninstall.sh']) {
  await cp(path.join(root, 'scripts', script), path.join(destination, script));
  await chmod(path.join(destination, script), 0o755);
}
await rename(path.join(destination, 'electron'), path.join(destination, 'yansi'));
await writeFile(path.join(destination, 'Yansi.sh'), '#!/bin/sh\nAPP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nunset ELECTRON_RUN_AS_NODE\nexec "$APP_DIR/yansi" "$@"\n');
await chmod(path.join(destination, 'Yansi.sh'), 0o755);
const archive = path.join(output, `${name}-${manifest.version}.tar.gz`);
const result = spawnSync('tar', ['-czf', archive, '-C', output, name], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Taşınabilir paket oluşturulamadı.');
console.log(`Paket hazır: ${archive}`);
console.log(`Çalıştır: ${path.join(destination, 'yansi')}`);
