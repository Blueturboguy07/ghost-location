import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venv = path.join(root, 'sidecar', '.venv');
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const target = `${process.platform}-${process.arch}`;
if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(target)) {
  throw new Error(`Unsupported build host ${target}; use native Windows x64 or macOS arm64/x64.`);
}
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit ${result.status}`);
}
if (!existsSync(python)) {
  const bootstrap = process.env.GHOST_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  run(bootstrap, ['-m', 'venv', venv]);
}
if (!process.argv.includes('--skip-install')) {
  run(python, ['-m', 'pip', 'install', '-r', 'sidecar/requirements-build.txt']);
}
const dist = path.join(root, 'resources', 'ios', target);
const work = path.join(root, 'sidecar', 'build', target);
mkdirSync(work, { recursive: true });
// Confine PyInstaller's build cache to the project too.
run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'ghost-ios',
  '--distpath', dist, '--workpath', work, '--specpath', work,
  '--recursive-copy-metadata', 'pymobiledevice3', '--collect-data', 'pymobiledevice3',
  '--collect-data', 'developer_disk_image', '--collect-data', 'pytun_pmd3',
  '--hidden-import', 'pymobiledevice3.osu.posix_util',
  '--hidden-import', 'pymobiledevice3.osu.win_util',
  'sidecar/ios_bridge.py'],
  { env: { ...process.env, PYINSTALLER_CONFIG_DIR: path.join(root, 'sidecar', 'build', 'cache') } });
const executable = path.join(dist, 'ghost-ios', process.platform === 'win32' ? 'ghost-ios.exe' : 'ghost-ios');
// Import + protocol smoke test, deliberately no USB discovery or device commands.
const smoke = spawnSync(executable, [], { encoding: 'utf8', timeout: 30000,
  input: '{"id":1,"method":"status","params":{}}\n{"id":2,"method":"shutdown","params":{}}\n' });
if (smoke.error || smoke.status !== 0) throw new Error(`Bundled sidecar smoke test failed: ${smoke.error || smoke.stderr}`);
const status = smoke.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.id === 1);
if (!status?.ok || !status.result?.available) throw new Error(`Bundled sidecar returned invalid status: ${smoke.stdout}`);
const lock = spawnSync(python, ['-m', 'pip', 'freeze'], { encoding: 'utf8' });
writeFileSync(path.join(dist, 'build-dependencies.txt'), lock.stdout);
const bridgeSha256 = createHash('sha256').update(readFileSync(path.join(root, 'sidecar', 'ios_bridge.py'))).digest('hex');
writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify({ target, pymobiledevice3: '11.12.4',
  builtAt: new Date().toISOString(), protocolVersion: 1, bridgeSha256 }, null, 2));
console.log(`Built and verified iPhone sidecar: ${executable}`);
