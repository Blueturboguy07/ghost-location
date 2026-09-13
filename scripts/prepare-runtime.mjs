import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childEnv = { ...process.env };
function execute(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: childEnv, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}`)));
  });
}
await execute(process.execPath, [path.join(root, 'scripts/prepare-android.mjs')]);
await execute(process.execPath, [path.join(root, 'scripts/build-ios-sidecar.mjs')]);
console.log('Ghost device runtimes are ready.');
