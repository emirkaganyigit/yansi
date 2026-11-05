import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = { ...process.env, YANSI_DATA_DIR: process.env.YANSI_DATA_DIR || path.join(root, '.local/development') };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root, ...process.argv.slice(2)], { cwd: root, env: environment, stdio: 'inherit' });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
