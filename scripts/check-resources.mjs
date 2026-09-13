import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Inspect executable headers without running anything. Universal macOS ADB is supported. */
export function supportsArchitecture(bytes, platform, arch, { allowWindowsX86 = false } = {}) {
  if (bytes.length < 64) return false;
  if (platform === 'win32') {
    if (bytes.toString('ascii', 0, 2) !== 'MZ') return false;
    const offset = bytes.readUInt32LE(60);
    if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' || arch !== 'x64') return false;
    const machine = bytes.readUInt16LE(offset + 4);
    return machine === 0x8664 || (allowWindowsX86 && machine === 0x014c);
  }
  const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007;
  if (bytes.readUInt32LE(0) === 0xfeedfacf) return bytes.readUInt32LE(4) === cpu;
  const magic = bytes.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
  const count = bytes.readUInt32BE(4);
  const size = magic === 0xcafebabf ? 32 : 20;
  if (count > 16 || 8 + count * size > bytes.length) return false;
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32BE(8 + index * size) === cpu) return true;
  }
  return false;
}

export function validateResources({ root = projectRoot, platform = process.platform, arch = process.arch, smoke = true } = {}) {
  const target = `${platform}-${arch}`;
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(target)) throw new Error(`Unsupported resource target ${target}.`);
  // electron-builder 26.15.3's ${platform} macro is process.platform. This app's
  // runtime preparation and PyInstaller output are deliberately native builds.
  if (smoke && (platform !== process.platform || arch !== process.arch)) {
    throw new Error(`Build ${target} on a matching native host; this host is ${process.platform}-${process.arch}.`);
  }
  const file = (relative) => {
    const absolute = path.join(root, relative);
    let info;
    try { info = statSync(absolute); } catch { throw new Error(`Missing resource: ${relative}`); }
    if (!info.isFile() || info.size === 0) throw new Error(`Resource is not a nonempty file: ${relative}`);
    return readFileSync(absolute);
  };
  const json = (relative) => JSON.parse(file(relative).toString('utf8'));
  const executable = (relative, options) => {
    if (!supportsArchitecture(file(relative), platform, arch, options)) throw new Error(`Executable does not support ${target}: ${relative}`);
    if (platform !== 'win32') accessSync(path.join(root, relative), constants.X_OK);
    return path.join(root, relative);
  };
  const adbDir = `resources/adb/${target}`;
  // Google's Windows platform-tools ships a 32-bit adb.exe that is supported
  // on Windows x64. Other packaged executables remain native-architecture only.
  const adb = executable(`${adbDir}/${platform === 'win32' ? 'adb.exe' : 'adb'}`, { allowWindowsX86: platform === 'win32' });
  const adbInfo = json(`${adbDir}/provenance.json`);
  if (adbInfo.platform !== platform || adbInfo.arch !== arch || !Array.isArray(adbInfo.files)) throw new Error('ADB provenance does not match the target.');
  const requiredAdb = platform === 'win32' ? ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'NOTICE.txt'] : ['adb', 'NOTICE.txt'];
  for (const name of requiredAdb) {
    if (!adbInfo.files.some((entry) => entry.file === name)) throw new Error(`ADB provenance is missing ${name}.`);
  }
  for (const entry of adbInfo.files) {
    if (typeof entry.file !== 'string' || path.basename(entry.file) !== entry.file ||
        sha256(file(`${adbDir}/${entry.file}`)) !== entry.sha256) throw new Error(`ADB resource failed integrity validation: ${entry.file}`);
  }
  const apk = file('resources/android/settings.apk');
  if (apk.length < 2 || apk.readUInt16LE(0) !== 0x4b50) throw new Error('Android helper is not an APK/ZIP archive.');
  const androidInfo = json('resources/android/provenance.json');
  const pkg = json('package.json');
  const pinnedHelper = pkg.devDependencies?.['io.appium.settings'] ?? pkg.dependencies?.['io.appium.settings'];
  if (androidInfo.name !== 'io.appium.settings' || androidInfo.version !== pinnedHelper || androidInfo.apkSha256 !== sha256(apk)) {
    throw new Error('Android helper version or checksum does not match its pinned provenance.');
  }
  if (!Array.isArray(androidInfo.notices) || !androidInfo.notices.some((name) => /^LICENSE/.test(name))) throw new Error('Android helper license notice is missing.');
  for (const name of androidInfo.notices) {
    if (typeof name !== 'string' || path.basename(name) !== name) throw new Error('Invalid Android notice path.');
    file(`resources/android/${name}`);
  }
  const iosDir = `resources/ios/${target}`;
  const ios = executable(`${iosDir}/ghost-ios/${platform === 'win32' ? 'ghost-ios.exe' : 'ghost-ios'}`);
  file(`${iosDir}/ghost-ios/_internal/base_library.zip`);
  file(`${iosDir}/build-dependencies.txt`);
  const iosInfo = json(`${iosDir}/build-info.json`);
  const pinnedIos = file('sidecar/requirements.txt').toString('utf8').match(/^pymobiledevice3==([^\s]+)$/m)?.[1];
  const bridgeSha256 = sha256(file('sidecar/ios_bridge.py'));
  if (!pinnedIos || iosInfo.target !== target || iosInfo.pymobiledevice3 !== pinnedIos || iosInfo.protocolVersion !== 1 ||
      iosInfo.bridgeSha256 !== bridgeSha256) {
    throw new Error('iPhone sidecar build metadata is stale or does not match the target.');
  }
  if (smoke) {
    // Neither smoke check enumerates or changes devices. ADB version does not start its server.
    const adbCheck = spawnSync(adb, ['version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (adbCheck.status !== 0 || !adbCheck.stdout.includes('Android Debug Bridge')) throw new Error(`ADB cannot run: ${adbCheck.error || adbCheck.stderr}`);
    const iosCheck = spawnSync(ios, [], { encoding: 'utf8', timeout: 30000, windowsHide: true,
      input: '{"id":1,"method":"status","params":{}}\n{"id":2,"method":"shutdown","params":{"restore":false}}\n' });
    if (iosCheck.status !== 0) throw new Error(`iPhone sidecar cannot run: ${iosCheck.error || iosCheck.stderr}`);
    const messages = iosCheck.stdout.trim().split('\n').map((line) => JSON.parse(line));
    if (!messages.some((message) => message.id === 1 && message.ok && message.result?.available && message.result?.protocolVersion === 1)) {
      throw new Error('iPhone sidecar did not confirm runtime availability.');
    }
  }
  return { target, adb, ios };
}

/** electron-builder hook checks its actual target even when invoked outside npm scripts. */
export async function beforePack(context) {
  const { Arch } = await import('builder-util');
  validateResources({ root: context.packager.projectDir, platform: context.electronPlatformName, arch: Arch[context.arch] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateResources({ platform: process.env.GHOST_TARGET_PLATFORM || process.platform, arch: process.env.GHOST_TARGET_ARCH || process.arch });
    console.log(`Device runtimes, architecture, provenance and launch checks passed for ${result.target}.`);
  } catch (error) {
    console.error(`Cannot ship an incomplete app: ${error.message}\nRun npm run runtime:prepare on the matching target OS/architecture first.`);
    process.exitCode = 1;
  }
}
